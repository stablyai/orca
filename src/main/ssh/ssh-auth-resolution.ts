import { existsSync } from 'node:fs'
import { utils, type BaseAgent, type ParsedKey } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './config/ssh-g-config-resolution'
import { createIdentityFilteredAgent } from './ssh-agent-identity-filter'
import { resolveSshConfigHomePath } from './config/ssh-config-path-expansion'
import { isOpenSshConfigBackedTarget } from './system-transport/system-ssh-args'
import { readSshIdentityFileSync } from './ssh-identity-file-read'
import { isAuthError } from './ssh-reconnect-error-classification'

// Why: ssh2 only tries keys that are explicitly provided. Users with keys in
// standard locations (e.g. ~/.ssh/id_ed25519) but no SSH agent running would
// fail to authenticate. Probe the regular and FIDO2 OpenSSH default paths.
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'id_xmss']
const DEFAULT_SECURITY_KEY_NAMES = ['id_ed25519_sk', 'id_ecdsa_sk']

const DEFAULT_KEY_PATHS = DEFAULT_KEY_NAMES.map((name) => `~/.ssh/${name}`)
const DEFAULT_IDENTITY_PATHS = [...DEFAULT_KEY_NAMES, ...DEFAULT_SECURITY_KEY_NAMES].map(
  (name) => `~/.ssh/${name}`
)
const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// Why: resolved IdentityFile paths are expanded before auth resolution, so they
// won't match the ~/... form in DEFAULT_KEY_PATHS.
const EXPANDED_DEFAULT_KEY_PATHS = DEFAULT_IDENTITY_PATHS.map(resolveSshConfigHomePath)

export type PrivateKeyFile = { path: string; contents: Buffer }

export function listDefaultIdentityFilePaths(): string[] {
  return [...DEFAULT_IDENTITY_PATHS]
}

/** Identity files one connect attempt could not use, by configured path, with the reason. */
export type SkippedIdentityFiles = Map<string, string>

export function findDefaultKeyFile(skipped?: SkippedIdentityFiles): PrivateKeyFile | undefined {
  for (const keyPath of DEFAULT_KEY_PATHS) {
    const key = existsSync(resolveSshConfigHomePath(keyPath))
      ? readPrivateKey(keyPath, skipped)
      : undefined
    if (key) {
      return key
    }
  }
  return undefined
}

function expandIdentityAgentEnv(value: string): string | undefined {
  if (value === 'SSH_AUTH_SOCK') {
    return process.env.SSH_AUTH_SOCK || undefined
  }

  let missingEnv = false
  const expanded = value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, bare, braced) => {
    const envName = String(bare || braced)
    const envValue = process.env[envName]
    if (envValue === undefined) {
      missingEnv = true
      return ''
    }
    return envValue
  })

  return missingEnv ? undefined : expanded
}

function resolveDefaultAgentSocket(): string | undefined {
  return (
    process.env.SSH_AUTH_SOCK ||
    (process.platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined)
  )
}

export function resolveAgentSocket(
  target: Pick<SshTarget, 'identityAgent' | 'configHost' | 'source' | 'host'>,
  resolved: Pick<SshResolvedConfig, 'identityAgent'> | null
): string | undefined {
  // Why: imported config-host targets may contain raw OpenSSH tokens like %d.
  // ssh -G resolves those tokens, so its value must win when available.
  const configuredIdentityAgent = isOpenSshConfigBackedTarget(target)
    ? (resolved?.identityAgent ?? target.identityAgent)
    : (target.identityAgent ?? resolved?.identityAgent)
  if (configuredIdentityAgent != null) {
    const trimmed = configuredIdentityAgent.trim()
    if (!trimmed || trimmed.toLowerCase() === 'none') {
      return undefined
    }
    return expandIdentityAgentEnv(resolveSshConfigHomePath(trimmed))
  }
  return resolveDefaultAgentSocket()
}

function resolveExplicitPrivateKeyPaths(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): string[] {
  const resolvedIdentities = (resolved?.identityFile ?? []).filter(
    (identityFile) => !EXPANDED_DEFAULT_KEY_PATHS.includes(identityFile)
  )
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return resolvedIdentities
  }
  if (target.identityFile) {
    return [target.identityFile]
  }
  return resolvedIdentities
}

export function resolveIdentityFilePaths(
  target: SshTarget,
  resolved: Pick<SshResolvedConfig, 'identityFile'> | null
): string[] {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return resolved.identityFile
  }
  if (target.identityFile) {
    return [target.identityFile]
  }
  return resolved?.identityFile ?? []
}

const MAX_WARNED_IDENTITY_FILE_PROBLEMS = 64
const warnedIdentityFileProblems = new Set<string>()

// Why: every reconnect and credential retry re-reads keys; one warning per path and problem is enough.
function warnSkippedIdentityFileOnce(keyPath: string, problem: string): void {
  const key = `${keyPath}\0${problem}`
  if (warnedIdentityFileProblems.has(key)) {
    return
  }
  if (warnedIdentityFileProblems.size >= MAX_WARNED_IDENTITY_FILE_PROBLEMS) {
    warnedIdentityFileProblems.clear()
  }
  warnedIdentityFileProblems.add(key)
  console.warn(`[ssh] Skipping identity file "${keyPath}": ${problem}`)
}

function readPrivateKey(
  keyPath: string,
  skipped: SkippedIdentityFiles | undefined
): PrivateKeyFile | undefined {
  const read = readSshIdentityFileSync(resolveSshConfigHomePath(keyPath))
  if (read.contents) {
    skipped?.delete(keyPath)
    return { path: keyPath, contents: read.contents }
  }
  if (read.problem) {
    skipped?.set(keyPath, read.problem)
    warnSkippedIdentityFileOnce(keyPath, read.problem)
  }
  return undefined
}

function readPrivateKeys(keyPaths: string[], skipped?: SkippedIdentityFiles): PrivateKeyFile[] {
  const keys: PrivateKeyFile[] = []
  for (const keyPath of keyPaths) {
    const key = readPrivateKey(keyPath, skipped)
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

function resolveExplicitPrivateKeys(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  skipped?: SkippedIdentityFiles
): PrivateKeyFile[] {
  return readPrivateKeys(resolveExplicitPrivateKeyPaths(target, resolved), skipped)
}

export function resolvePrivateKeys(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  skipped?: SkippedIdentityFiles
): PrivateKeyFile[] {
  const keyPaths = resolveIdentityFilePaths(target, resolved)
  if (keyPaths.length > 0 || resolved || target.identityFile) {
    return readPrivateKeys(keyPaths, skipped)
  }
  const defaultKey = findDefaultKeyFile(skipped)
  return defaultKey ? [defaultKey] : []
}

/** Names the identity files auth had to skip, so a generic auth failure says which key and why. */
export function withSkippedIdentityFileDetail(
  error: unknown,
  skipped: SkippedIdentityFiles
): unknown {
  if (!(error instanceof Error) || !isAuthError(error) || skipped.size === 0) {
    return error
  }
  const detail = [...skipped].map(([keyPath, problem]) => `"${keyPath}" (${problem})`).join(', ')
  error.message = `${error.message.replace(/\.$/, '')}. Orca skipped identity file ${detail}.`
  return error
}

export function isUnencryptedPrivateKey(contents: Buffer): boolean {
  const parsed = utils.parseKey(contents) as ParsedKey | ParsedKey[] | Error
  if (parsed instanceof Error) {
    return false
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed]
  return keys.some((key) => key && typeof key.isPrivateKey === 'function' && key.isPrivateKey())
}

export function resolveUnencryptedExplicitPrivateKeys(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  skipped?: SkippedIdentityFiles
): PrivateKeyFile[] {
  return resolveExplicitPrivateKeys(target, resolved, skipped).filter((key) =>
    isUnencryptedPrivateKey(key.contents)
  )
}

export function findEncryptedPrivateKeyPath(keys: PrivateKeyFile[]): string | undefined {
  for (const key of keys) {
    const parsed = utils.parseKey(key.contents) as ParsedKey | ParsedKey[] | Error
    if (parsed instanceof Error && /passphrase|encrypted key|bad decrypt/i.test(parsed.message)) {
      return key.path
    }
  }
  return undefined
}

export function resolveAgentConfigValue(
  agentSocket: string,
  target: SshTarget,
  resolved: SshResolvedConfig | null
): BaseAgent | string | undefined {
  const identitiesOnly = resolved?.identitiesOnly ?? target.identitiesOnly ?? false
  if (!identitiesOnly) {
    return agentSocket
  }

  return createIdentityFilteredAgent(agentSocket, resolveIdentityFilePaths(target, resolved))
}
