// The execution host's own `agy acp`: preferred for new chats when it answers as a compatible server.

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import { AcpConnectionClosedError } from '../acp/transport/acp-errors'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/antigravity-session-origin'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { initializeAntigravityAcp } from './antigravity-acp-runtime-probe'
import {
  createAntigravityHostCredentialBackend,
  isAntigravityFileStorageHost
} from './native-credential-backend'
import { hasAntigravityMacOSCredential } from './native-macos-credentials'

/** First release verified with Orca chats; it also leaves the chat's folder untouched. */
export const ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION = '1.5.2'
/** agy keeps its sign-in and conversations here and ignores GEMINI_HOME, so this only pins the chat. */
const AGY_HOME_FOLDER = '.gemini'
/** Approves tools, not plans; the check launches with it, so a build without it stays managed. */
export const AGY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'
// agy.exe can take 6-7s to list sessions while Orca starts on Windows.
const PROBE_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 5_000
const RECHECK_MS = 5 * 60_000

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
    Boolean(capabilities.sessionCapabilities?.list)
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

// Keyed by the binary's identity so an upgrade or reinstall is checked again.
type HostCheck = { identity: string; answer: Promise<boolean>; retryAt?: number }
const checks = new Map<string, HostCheck>()

/** Clear cached host ACP readiness checks and retire any cached host model catalog for `homePath`. */
export function expireAntigravityHostAcpChecks(homePath?: string): void {
  checks.clear()
  if (homePath !== undefined) {
    agentModelCatalogStore.expireAgent(
      'antigravity',
      agentModelCatalogFingerprint({
        agent: 'antigravity',
        accountHome: antigravityHostAccountHome(homePath),
        wslDistro: null
      })
    )
  }
}

class IncompatibleHostAcp extends Error {}

/** Whether `command acp` initializes as a compatible server that serves session requests. An
 *  incompatible binary is not asked again; a sign-in can lapse or a hung agy recover, so any other
 *  answer is checked again after a while. */
export async function antigravityHostAcpReady(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  prefixArgs: readonly string[] = [],
  now = Date.now
): Promise<boolean> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const prefixStats = await Promise.all(
    prefixArgs
      .filter((arg) => !arg.startsWith('-'))
      .map(async (arg) => {
        const st = await stat(arg).catch(() => null)
        return st?.isFile() ? `${arg}:${st.size}:${st.mtimeMs}` : null
      })
  )
  const trackedPrefixFiles = prefixStats.filter((item): item is string => item !== null)
  const cacheKey = `${command}\0${prefixArgs.join('\0')}`
  const identity = [`${stats.size}:${stats.mtimeMs}`, ...trackedPrefixFiles].join('\0')
  const cached = checks.get(cacheKey)
  if (cached?.identity === identity && (cached.retryAt === undefined || now() < cached.retryAt)) {
    return cached.answer
  }
  let answered = false
  const check: HostCheck = {
    identity,
    retryAt: now() + RECHECK_MS,
    answer: initializeAntigravityAcp(
      () => ({
        command,
        args: [...prefixArgs, 'acp', AGY_SKIP_PERMISSIONS_FLAG],
        env,
        envToDelete
      }),
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
        await connection.listSessions(folder)
      }
    ).then(
      () => true,
      (error: unknown) => {
        // An exit before initialize answers is a binary rejecting the launch flag, not a lapse.
        const canPinRejection = prefixArgs.length === 0 || trackedPrefixFiles.length > 0
        if (
          canPinRejection &&
          (error instanceof IncompatibleHostAcp ||
            (!answered && error instanceof AcpConnectionClosedError))
        ) {
          check.retryAt = undefined
        }
        return false
      }
    )
  }
  checks.set(cacheKey, check)
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

/** Whether Orca's own Chat holds the managed server's personal sign-in token. */
export async function hasManagedAntigravityChatSignIn(managedHome: string): Promise<boolean> {
  const token = join(managedHome, ANTIGRAVITY_ACP_HOME, 'acp_token.json')
  return (await stat(token).catch(() => null)) !== null
}

/** Whether agy itself is signed in on this host; an unreadable store counts as signed out. */
export async function hasAgyCredential(homePath: string): Promise<boolean> {
  try {
    // Reading the macOS secret would ask the person for keychain access; its attributes do not.
    if (process.platform === 'darwin' && !isAntigravityFileStorageHost(process.env)) {
      return (
        (await hasAntigravityMacOSCredential()) ||
        existsSync(join(homePath, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
      )
    }
    return (await createAntigravityHostCredentialBackend(homePath).read()) !== null
  } catch {
    return false
  }
}
