// The execution host's own `agy acp`: preferred for new chats when it answers as a compatible server.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { AcpAgentError, AcpConnectionClosedError } from '../acp/transport/acp-errors'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { initializeAntigravityAcp } from './antigravity-acp-runtime-probe'
import { antigravityTakesSystemPrompt } from '../acp/launch/acp-instructions'

/** The oldest agy shown to run a chat on a home it is given (`--gemini-dir`) and to ignore an
 *  inherited GEMINI_API_KEY unless its own settings pick a key provider (checked on 1.5.5, 1.5.13
 *  and 1.5.16), so Orca passes the key through untouched. */
export const ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION = '1.5.5'
/** agy keeps its sign-in and conversations here and ignores GEMINI_HOME, so this only pins the chat. */
const AGY_HOME_FOLDER = '.gemini'
/** Approves tools, not plans; the check launches with it, so a build without it stays managed. */
export const AGY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'
// agy.exe took 6-7s to list sessions while Orca started, and Windows has no managed fallback.
const PROBE_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 5_000
const RECHECK_MS = 5 * 60_000
// ACP's "authentication required" error.
const ACP_AUTH_REQUIRED_CODE = -32000

export function isCompatibleAntigravityHostAcp(initialized: InitializeResponse): boolean {
  const capabilities = initialized.agentCapabilities
  const version = initialized.agentInfo?.version ?? ''
  return (
    initialized.agentInfo?.name === 'Antigravity ACP Server' &&
    isValidAppVersion(version) &&
    compareAppVersions(version, ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION) >= 0 &&
    initialized.protocolVersion === 1 &&
    capabilities?.loadSession === true &&
    Boolean(capabilities.sessionCapabilities?.resume) &&
    // Readiness is checked by listing sessions.
    Boolean(capabilities.sessionCapabilities?.list) &&
    // A managed agent's identity rides the system prompt; without it Orca's own server runs.
    antigravityTakesSystemPrompt(initialized)
  )
}

/** The account home of chats pinned to the host's agy and its own sign-in. */
export function antigravityHostAccountHome(homePath: string): AgentSessionAccountHome {
  return { variable: 'GEMINI_HOME', path: join(homePath, AGY_HOME_FOLDER) }
}

/** The catalogs listed with the host's agy login: under `launchHome`, or each home Orca itself
 *  resolves it from. */
export function antigravityHostCatalogFingerprints(launchHome?: string): string[] {
  const homes = new Set(
    (launchHome ? [launchHome] : [homedir(), process.env.HOME, process.env.USERPROFILE]).filter(
      Boolean
    )
  )
  return [...homes].map((home) =>
    agentModelCatalogFingerprint({
      agent: 'antigravity',
      accountHome: antigravityHostAccountHome(home!),
      wslDistro: null
    })
  )
}

/** Managed chats pin `<userData>/antigravity-chat`, so only this folder name selects the host's agy. */
export function isAntigravityHostAccountHome(home: AgentSessionAccountHome): boolean {
  return (
    isLegacyAgentSessionAccountHome(home) &&
    home.variable === 'GEMINI_HOME' &&
    home.path.split(/[\\/]+/).findLast(Boolean) === AGY_HOME_FOLDER
  )
}

/** What `agy acp` answered: serving sessions, a compatible server asking to sign in, a binary
 *  that can't serve Orca's chats, or no answer (hung or crashed). */
export type AntigravityHostAcpAnswer = 'ready' | 'signedOut' | 'incompatible' | 'unanswered'
// Keyed by the binary's identity so an upgrade or reinstall is checked again.
type HostCheck = {
  identity: string
  answer: Promise<AntigravityHostAcpAnswer>
  retryAt?: number
  version?: string
}
const checks = new Map<string, HostCheck>()

class IncompatibleHostAcp extends Error {}

let answersRevision = 0
const answerListeners = new Set<() => void>()

function answersChanged(): void {
  answersRevision += 1
  answerListeners.forEach((listener) => listener())
}

/** After agy's login changes, the next check asks again instead of trusting the last answer. */
export function forgetAntigravityHostAcpChecks(): void {
  checks.clear()
  latestAsked = null
  answersChanged()
}

// The check behind the latest answer, cached or not, so the version is never another binary's.
let latestAsked: HostCheck | null = null

/** The version of the agy the latest answer vouched for, for naming what chats run on; null when it
 *  did not pass. Reads the cache only, so it never starts agy. */
export function readyAntigravityHostAcpVersion(): string | null {
  return latestAsked?.version ?? null
}

/** Rises when checks are forgotten or a recheck answers differently, so remembered choices retire. */
export function antigravityHostAcpChecksRevision(): number {
  return answersRevision
}

export function onAntigravityHostAcpAnswersChanged(listener: () => void): () => void {
  answerListeners.add(listener)
  return () => answerListeners.delete(listener)
}

/** Whether `command acp` initializes as a compatible server that serves session requests. */
export async function antigravityHostAcpReady(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  now = Date.now
): Promise<boolean> {
  return (await checkAntigravityHostAcp(command, env, envToDelete, now)) === 'ready'
}

/** One check answers every question about `command acp`. An incompatible binary is not asked
 *  again; a sign-in can land or lapse and a hung agy recover, so other answers are rechecked. */
export function checkAntigravityHostAcp(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  now: () => number = Date.now
): Promise<AntigravityHostAcpAnswer> {
  return askAntigravityHostAcp(command, env, envToDelete, now, true)
}

/** Whether `command acp` is a compatible server, asked without a session request, which would make
 *  agy read its login: `ready` here means compatible, signed in or not. */
export function checkAntigravityHostAcpCompatible(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  { start }: { start: boolean }
): Promise<AntigravityHostAcpAnswer> {
  return askAntigravityHostAcp(command, env, envToDelete, Date.now, false, start)
}

async function askAntigravityHostAcp(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  now: () => number,
  sessions: boolean,
  start = true
): Promise<AntigravityHostAcpAnswer> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return 'unanswered'
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const key = sessions ? command : `${command}\u0000initialize`
  const cached = checks.get(key)
  if (cached?.identity === identity && (cached.retryAt === undefined || now() < cached.retryAt)) {
    if (sessions) {
      latestAsked = cached
    }
    return cached.answer
  }
  // Nobody is using Antigravity yet, so agy isn't started to answer.
  if (!start) {
    return 'unanswered'
  }
  let answered = false
  const check: HostCheck = {
    identity,
    retryAt: now() + RECHECK_MS,
    answer: initializeAntigravityAcp(
      () => ({ command, args: ['acp', AGY_SKIP_PERMISSIONS_FLAG], env, envToDelete }),
      PROBE_TIMEOUT_MS,
      undefined,
      async (connection, initialized, folder) => {
        answered = true
        if (!isCompatibleAntigravityHostAcp(initialized)) {
          throw new IncompatibleHostAcp()
        }
        // A present keychain item does not prove agy can sign in silently; session requests
        // answer "Authentication required" until it has. Unlike session/new, listing writes no
        // conversation into agy's history.
        if (sessions) {
          await connection.listSessions({ cwd: folder })
        }
      }
    ).then(
      (initialized): AntigravityHostAcpAnswer => {
        if (sessions) {
          check.version = initialized.agentInfo?.version
        } else {
          // Compatibility changes only with the binary, whose identity keys this check.
          check.retryAt = undefined
        }
        return 'ready'
      },
      (error: unknown): AntigravityHostAcpAnswer => {
        if (error instanceof AcpAgentError && error.code === ACP_AUTH_REQUIRED_CODE) {
          return 'signedOut'
        }
        // An exit before initialize answers is a binary rejecting the launch flag, not a lapse.
        if (
          error instanceof IncompatibleHostAcp ||
          (!answered && error instanceof AcpConnectionClosedError)
        ) {
          check.retryAt = undefined
          return 'incompatible'
        }
        return 'unanswered'
      }
    )
  }
  checks.set(key, check)
  if (sessions) {
    latestAsked = check
  }
  // A first answer or a changed one retires choices made without it.
  const previous = cached?.answer ?? Promise.resolve(null)
  void Promise.all([previous, check.answer]).then(([before, after]) => {
    if (before !== after) {
      answersChanged()
    }
  })
  return check.answer
}

/** Whether agy's settings select an API-key model provider; host chats drop inherited keys. */
export async function agyUsesApiKey(homePath: string): Promise<boolean> {
  const text = await readFile(
    join(homePath, AGY_HOME_FOLDER, 'antigravity-cli', 'settings.json'),
    'utf8'
  ).catch(() => null)
  if (text === null) {
    return false
  }
  try {
    const settings: unknown = JSON.parse(text)
    return typeof settings === 'object' && settings !== null && 'modelProvider' in settings
      ? Boolean(settings.modelProvider)
      : false
  } catch {
    // Settings agy may read differently than JSON.parse could select a provider.
    return true
  }
}

/** Whether agy's own settings leave it on personal Google sign-in: no model provider and no other
 *  auth type. Settings JSON.parse can't read count as something else. */
export async function agySignsInWithPersonalGoogle(homePath: string): Promise<boolean> {
  const text = await readFile(
    join(homePath, AGY_HOME_FOLDER, 'antigravity-cli', 'settings.json'),
    'utf8'
  ).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined))
  // Missing: agy's defaults. Unreadable: unknown, so not the same sign-in.
  if (text === null || text === undefined) {
    return text === null
  }
  try {
    const settings: unknown = JSON.parse(text)
    if (typeof settings !== 'object' || settings === null) {
      return false
    }
    const auth = 'auth' in settings ? settings.auth : undefined
    const type = typeof auth === 'object' && auth !== null && 'type' in auth ? auth.type : undefined
    return (
      !('modelProvider' in settings && settings.modelProvider) &&
      (auth === undefined || type === undefined || type === 'oauth-personal')
    )
  } catch {
    return false
  }
}
