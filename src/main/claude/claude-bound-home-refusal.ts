import { statSync } from 'node:fs'
import type { ResolvedClaudeHomeBinding } from '../../shared/claude-home-binding'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { readClaudeConfigDirScopedOAuthCredentials } from '../rate-limits/claude-oauth-credentials'
import { sameClaudeConfigDir } from './claude-config-dir-identity'

/** Why a bound group home cannot be launched against. Never a silent fallback to the shared home:
 *  the user asked for one identity, and quietly substituting another is the failure this prevents. */
export type ClaudeBoundHomeRefusal =
  | { code: 'claude_bound_home_missing'; groupId: string; configDir: string }
  | { code: 'claude_bound_home_signed_out'; groupId: string; configDir: string }
  | { code: 'claude_bound_home_credentials_unreadable'; groupId: string; configDir: string }
  | {
      code: 'claude_bound_home_predates_binding'
      groupId: string
      configDir: string
      accountHomePath: string
    }
  | { code: 'claude_bound_home_host_unsupported'; groupId: string; configDir: string }
  | {
      code: 'claude_bound_home_env_conflict'
      groupId: string
      configDir: string
      launchEnvDir: string
    }

function refusalMessage(refusal: ClaudeBoundHomeRefusal): string {
  const prefix = `Project group ${refusal.groupId} binds Claude to ${refusal.configDir}`
  switch (refusal.code) {
    case 'claude_bound_home_host_unsupported':
      return `${prefix}, which only a local workspace can use. Remote and WSL workspaces cannot open a chat under a bound Claude directory.`
    case 'claude_bound_home_missing':
      return `${prefix}, which is not an existing directory on this machine.`
    case 'claude_bound_home_signed_out':
      return `${prefix}, which holds no Claude credentials. Sign in to Claude under that directory first.`
    case 'claude_bound_home_env_conflict':
      return `${prefix}, but the launch environment sets CLAUDE_CONFIG_DIR to ${refusal.launchEnvDir}.`
    case 'claude_bound_home_credentials_unreadable':
      return `${prefix}, whose Claude credentials this machine cannot read right now — the login keychain is locked, or access to it was denied. Unlock the keychain or grant access and try again; that directory is already signed in, so signing in again would only add a second credential.`
    case 'claude_bound_home_predates_binding':
      return `${prefix}, but this conversation was created under ${refusal.accountHomePath} and keeps it — an account home is pinned when the chat is created, so a binding added later never reaches it. Start a new chat in this group to work under ${refusal.configDir}.`
  }
}

export class ClaudeBoundHomeRefusalError extends Error {
  readonly refusal: ClaudeBoundHomeRefusal

  constructor(refusal: ClaudeBoundHomeRefusal) {
    super(refusalMessage(refusal))
    this.name = 'ClaudeBoundHomeRefusalError'
    this.refusal = refusal
  }
}

/** Test seam only: production passes nothing and reads the real platform and Keychain. */
export type ClaudeBoundHomeProbe = {
  platform?: NodeJS.Platform
  readScopedKeychainCredentials?: (configDir: string) => Promise<string | null>
}

function isAbsoluteBinding(configDir: string): boolean {
  return isWindowsAbsolutePathLike(configDir) || configDir.startsWith('/')
}

/** The repo's own config-dir-scoped credential read, on every platform: the scoped Keychain item
 *  a macOS OAuth login writes, then this directory's `.credentials.json`.
 *
 *  `unreadable` is kept apart from `absent` because the two have different remedies: a directory
 *  nobody signed into needs a sign-in, and a Keychain this process cannot open does not. */
async function readCredentialStatus(
  configDir: string,
  probe: ClaudeBoundHomeProbe
): Promise<'present' | 'absent' | 'unreadable'> {
  const credentials = await readClaudeConfigDirScopedOAuthCredentials(configDir, {
    platform: probe.platform ?? process.platform,
    ...(probe.readScopedKeychainCredentials
      ? { readScopedKeychain: probe.readScopedKeychainCredentials }
      : {})
  })
  if (credentials.token || credentials.hasRefreshableCredentials) {
    return 'present'
  }
  return credentials.keychainUnavailable ? 'unreadable' : 'absent'
}

/**
 * Proves a bound group home can actually serve this launch, before anything is committed.
 * Reads only — Orca never writes into a directory a group bound.
 */
export async function assertClaudeBoundHomeUsable(input: {
  binding: ResolvedClaudeHomeBinding
  location: { executionHostId: string | null; wslDistro: string | null }
  launchEnv: NodeJS.ProcessEnv
  probe?: ClaudeBoundHomeProbe
}): Promise<void> {
  const { configDir, groupId } = input.binding
  const probe = input.probe ?? {}
  const platform = probe.platform ?? process.platform
  const refuse = (refusal: ClaudeBoundHomeRefusal): never => {
    throw new ClaudeBoundHomeRefusalError(refusal)
  }
  // A config dir is a path on exactly one host. Losing contact with a remote host proves nothing
  // about it either way (docs/reference/ssh-execution-boundary.md), so this host never guesses:
  // only a local, non-WSL workspace may read a bound directory at all.
  if (input.location.executionHostId !== LOCAL_EXECUTION_HOST_ID || input.location.wslDistro) {
    refuse({ code: 'claude_bound_home_host_unsupported', groupId, configDir })
  }
  if (
    !isAbsoluteBinding(configDir) ||
    !statSync(configDir, { throwIfNoEntry: false })?.isDirectory()
  ) {
    refuse({ code: 'claude_bound_home_missing', groupId, configDir })
  }
  const launchEnvDir = input.launchEnv.CLAUDE_CONFIG_DIR?.trim()
  if (launchEnvDir && !sameClaudeConfigDir(launchEnvDir, configDir, platform)) {
    refuse({ code: 'claude_bound_home_env_conflict', groupId, configDir, launchEnvDir })
  }
  const credentials = await readCredentialStatus(configDir, probe)
  if (credentials === 'unreadable') {
    refuse({ code: 'claude_bound_home_credentials_unreadable', groupId, configDir })
  }
  if (credentials === 'absent') {
    refuse({ code: 'claude_bound_home_signed_out', groupId, configDir })
  }
}

export type AssertClaudeBoundHomeUsable = typeof assertClaudeBoundHomeUsable
