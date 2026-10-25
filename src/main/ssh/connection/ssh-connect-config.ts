import type { ConnectConfig } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import {
  findEncryptedPrivateKeyPath,
  isUnencryptedPrivateKey,
  resolveAgentConfigValue,
  resolveAgentSocket,
  resolvePrivateKeys,
  resolveUnencryptedExplicitPrivateKeys,
  type SkippedIdentityFiles
} from '../ssh-auth-resolution'
import { configurePrivateKeyAuthentication } from '../ssh-private-key-authentication'
import { isOpenSshConfigBackedTarget } from '../system-transport/system-ssh-args'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-timing'

export type BuildConnectConfigOptions = {
  includeAgent?: boolean
  includePrivateKey?: boolean
  /** No agent and no key: only the host's keyboard-interactive challenge (and a cached password). */
  keyboardInteractiveOnly?: boolean
  /** Collects identity files this config could not use, for the attempt's final error. */
  skippedIdentityFiles?: SkippedIdentityFiles
}

// ssh2 parses privateKey before agent auth; defer encrypted keys until the post-agent passphrase path.
export function buildConnectConfig(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: BuildConnectConfigOptions = {}
): ConnectConfig {
  const effectiveHost = resolveEffectiveHost(target, resolved)
  const effectivePort = resolveEffectivePort(target, resolved)
  const effectiveUser =
    isOpenSshConfigBackedTarget(target) && resolved
      ? (resolved.user ?? target.username)
      : target.username || resolved?.user || ''

  const config: Record<string, unknown> = {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    // Allow RFC4256 keyboard-interactive challenges, including MFA after partial password success.
    tryKeyboard: true
  }

  const shouldIncludeAgent = !options.keyboardInteractiveOnly && (options.includeAgent ?? true)
  const agentSocket = shouldIncludeAgent ? resolveAgentSocket(target, resolved) : undefined
  const agent = agentSocket ? resolveAgentConfigValue(agentSocket, target, resolved) : undefined

  if (agent) {
    config.agent = agent
  }

  if (agent && resolved?.forwardAgent) {
    config.agentForward = true
  }

  const keys = options.keyboardInteractiveOnly
    ? []
    : (options.includePrivateKey ?? !agent)
      ? resolvePrivateKeys(target, resolved, options.skippedIdentityFiles)
      : resolveUnencryptedExplicitPrivateKeys(target, resolved, options.skippedIdentityFiles)
  let deferralDecision: boolean | undefined
  configurePrivateKeyAuthentication(
    config as ConnectConfig,
    keys,
    findEncryptedPrivateKeyPath(keys),
    {
      // Defer the host challenge only for one usable unencrypted post-agent key; multiple attempts risk MaxAuthTries. Read deferred files lazily only after agent failure.
      deferKeyboardInteractive:
        keys.length === 0 && !options.keyboardInteractiveOnly
          ? () => {
              if (deferralDecision === undefined) {
                const deferredKeys = resolvePrivateKeys(target, resolved)
                deferralDecision =
                  deferredKeys.length === 1 && isUnencryptedPrivateKey(deferredKeys[0].contents)
              }
              return deferralDecision
            }
          : undefined
    }
  )

  return config as ConnectConfig
}

function resolveEffectiveHost(target: SshTarget, resolved: SshResolvedConfig | null): string {
  if (isOpenSshConfigBackedTarget(target) && resolved?.hostname) {
    return resolved.hostname
  }
  if (shouldUseResolvedEndpoint(target, resolved)) {
    return resolved!.hostname
  }
  return target.host || resolved?.hostname || target.label
}

function resolveEffectivePort(target: SshTarget, resolved: SshResolvedConfig | null): number {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return resolved.port || target.port || 22
  }
  // Config aliases persist default22 even when Include/wildcard rules resolve a different port.
  if (target.configHost && target.port === 22 && resolved?.port) {
    return resolved.port
  }
  return target.port || resolved?.port || 22
}

function shouldUseResolvedEndpoint(target: SshTarget, resolved: SshResolvedConfig | null): boolean {
  if (!target.configHost || !resolved?.hostname) {
    return false
  }
  const host = target.host.trim()
  return host === '' || host === target.configHost || host === target.label
}
