import { existsSync, readFileSync } from 'node:fs'
import { utils, type BaseAgent, type ParsedKey } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { createIdentityFilteredAgent } from './ssh-agent-identity-filter'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'

// Why: ssh2 only tries keys that are explicitly provided. Users with keys in
// standard locations (e.g. ~/.ssh/id_ed25519) but no SSH agent running would
// fail to authenticate. Probing default paths matches VS Code's _findDefaultKeyFile.
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'id_xmss']

const DEFAULT_KEY_PATHS = DEFAULT_KEY_NAMES.map((name) => `~/.ssh/${name}`)
const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// Why: resolved IdentityFile paths are expanded before auth resolution, so they
// won't match the ~/... form in DEFAULT_KEY_PATHS.
const EXPANDED_DEFAULT_KEY_PATHS = DEFAULT_KEY_PATHS.map(resolveSshConfigHomePath)

export type PrivateKeyFile = { path: string; contents: Buffer }

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
  target: Pick<SshTarget, 'identityAgent' | 'configHost'>,
  resolved: Pick<SshResolvedConfig, 'identityAgent'> | null
): string | undefined {
  // Why: imported config-host targets may contain raw OpenSSH tokens like %d.
  // ssh -G resolves those tokens, so its value must win when available.
  const configuredIdentityAgent = target.configHost
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

function resolveExplicitPrivateKeyPath(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): string | undefined {
  const resolvedIdentity = resolved?.identityFile?.[0]
  return (
    target.identityFile ||
    (resolvedIdentity && !EXPANDED_DEFAULT_KEY_PATHS.includes(resolvedIdentity)
      ? resolvedIdentity
      : undefined)
  )
}

function readPrivateKey(keyPath: string): PrivateKeyFile | undefined {
  try {
    const resolvedPath = resolveSshConfigHomePath(keyPath)
    return { path: keyPath, contents: readFileSync(resolvedPath) }
  } catch {
    return undefined
  }
}

function resolveExplicitPrivateKey(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): PrivateKeyFile | undefined {
  const explicitKey = resolveExplicitPrivateKeyPath(target, resolved)
  if (explicitKey) {
    return readPrivateKey(explicitKey)
  }
  return undefined
}

export function resolvePrivateKey(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): PrivateKeyFile | undefined {
  if (resolveExplicitPrivateKeyPath(target, resolved)) {
    return resolveExplicitPrivateKey(target, resolved)
  }
  return findDefaultKeyFile()
}

function isUnencryptedPrivateKey(contents: Buffer): boolean {
  const parsed = utils.parseKey(contents) as ParsedKey | ParsedKey[] | Error
  if (parsed instanceof Error) {
    return false
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed]
  return keys.some((key) => key && typeof key.isPrivateKey === 'function' && key.isPrivateKey())
}

export function resolveUnencryptedExplicitPrivateKey(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): PrivateKeyFile | undefined {
  const key = resolveExplicitPrivateKey(target, resolved)
  if (!key) {
    return undefined
  }
  return isUnencryptedPrivateKey(key.contents) ? key : undefined
}

function resolveIdentityFilePaths(target: SshTarget, resolved: SshResolvedConfig | null): string[] {
  if (target.configHost && resolved?.identityFile?.length) {
    return resolved.identityFile
  }
  if (target.identityFile) {
    return [target.identityFile]
  }
  return resolved?.identityFile ?? []
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
