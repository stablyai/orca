// Checks of the host's `agy acp`: whether it is a compatible server, and whether it is signed in.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
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

/** First release verified with Orca chats; it also leaves the chat's folder untouched. */
export const ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION = '1.5.2'
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

/** After agy's login changes, the next check asks again instead of trusting the last answer. */
export function forgetAntigravityHostAcpChecks(): void {
  checks.clear()
  latestAsked = null
}

// The check behind the latest answer, cached or not, so the version is never another binary's.
let latestAsked: HostCheck | null = null

/** The version of the agy the latest answer vouched for, for naming what chats run on; null when it
 *  did not pass. Reads the cache only, so it never starts agy. */
export function readyAntigravityHostAcpVersion(): string | null {
  return latestAsked?.version ?? null
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
  return check.answer
}
