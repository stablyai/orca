import { existsSync, readFileSync } from 'node:fs'
import type { BaseAgent } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { createIdentityFilteredAgent } from './ssh-agent-identity-filter'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

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

export type PrivateKeyFile = { path: string; contents: Buffer }

export function isPrivateKeyPassphraseError(err: Error): boolean {
  const message = err.message.toLowerCase()
  return (
    message.includes('passphrase') ||
    message.includes('encrypted key') ||
    message.includes('bad decrypt')
  )
}

export function listDefaultIdentityFilePaths(): string[] {
  return [...DEFAULT_IDENTITY_PATHS]
}

export function findDefaultKeyFile(): PrivateKeyFile | undefined {
  for (const keyPath of DEFAULT_KEY_PATHS) {
    const resolved = resolveSshConfigHomePath(keyPath)
    try {
      if (!existsSync(resolved)) {
        continue
      }
      const contents = readFileSync(resolved)
      return { path: keyPath, contents }
    } catch {
      continue
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

function readPrivateKey(keyPath: string): PrivateKeyFile | undefined {
  try {
    const resolvedPath = resolveSshConfigHomePath(keyPath)
    return { path: keyPath, contents: readFileSync(resolvedPath) }
  } catch {
    return undefined
  }
}

function readPrivateKeys(keyPaths: string[]): PrivateKeyFile[] {
  const keys: PrivateKeyFile[] = []
  for (const keyPath of keyPaths) {
    const key = readPrivateKey(keyPath)
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

export function resolvePrivateKeys(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): PrivateKeyFile[] {
  const keyPaths = resolveIdentityFilePaths(target, resolved)
  if (keyPaths.length > 0 || resolved || target.identityFile) {
    return readPrivateKeys(keyPaths)
  }
  const defaultKey = findDefaultKeyFile()
  return defaultKey ? [defaultKey] : []
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
