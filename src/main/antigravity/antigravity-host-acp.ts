// The execution host's own `agy acp`: preferred for new chats when it answers as a compatible server.

import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
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
const PROBE_TIMEOUT_MS = 5_000
const FAILED_CHECK_RETRY_MS = 5 * 60_000
/** The token files the managed agy-acp-server writes for personal and business sign-ins. */
const MANAGED_CHAT_TOKEN_FILES = ['acp_token.json', 'acp_business_token.json']

export function isCompatibleAntigravityHostAcp(initialized: InitializeResponse): boolean {
  const capabilities = initialized.agentCapabilities
  const version = initialized.agentInfo?.version ?? ''
  return (
    initialized.agentInfo?.name === 'Antigravity ACP Server' &&
    isValidAppVersion(version) &&
    compareAppVersions(version, ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION) >= 0 &&
    initialized.protocolVersion === 1 &&
    capabilities?.loadSession === true &&
    Boolean(capabilities.sessionCapabilities?.resume)
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

/** Whether `command acp` initializes as a compatible server; a failed check waits before retrying. */
export async function antigravityHostAcpAnswers(
  command: string,
  env: Record<string, string>,
  envToDelete: string[],
  now = Date.now
): Promise<boolean> {
  const stats = await stat(command).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const cached = checks.get(command)
  if (cached?.identity === identity && (cached.retryAt === undefined || now() < cached.retryAt)) {
    return cached.answer
  }
  const check: HostCheck = {
    identity,
    answer: initializeAntigravityAcp(
      () => ({ command, args: ['acp'], env, envToDelete }),
      PROBE_TIMEOUT_MS
    ).then(isCompatibleAntigravityHostAcp, () => {
      // A hung or crashing agy must not delay every chat start and availability read.
      check.retryAt = now() + FAILED_CHECK_RETRY_MS
      return false
    })
  }
  checks.set(command, check)
  return check.answer
}

/** Whether Orca's own Chat sign-in has left credentials in its managed home or a folder inside it. */
export async function hasManagedAntigravityChatSignIn(managedHome: string): Promise<boolean> {
  const entries = await readdir(managedHome, { withFileTypes: true }).catch(() => [])
  const folders = [
    managedHome,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(managedHome, entry.name))
  ]
  for (const folder of folders) {
    const names = await readdir(folder).catch(() => [])
    if (names.some((name) => MANAGED_CHAT_TOKEN_FILES.includes(name))) {
      return true
    }
  }
  return false
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
