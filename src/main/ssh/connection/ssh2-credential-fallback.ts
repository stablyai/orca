import type { ConnectConfig } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import type { SkippedIdentityFiles } from '../ssh-auth-resolution'
import type { SshCredentialKind } from './ssh-connection-callbacks'
import { buildConnectConfig } from './ssh-connect-config'
import type { resolveEffectiveProxy } from '../ssh-proxy-command'
import {
  isAgentFallbackError,
  isGssapiSystemSshFallbackCandidate,
  isPassphraseError,
  isSsh2AlgorithmNegotiationError,
  isSystemSshFallbackError
} from '../ssh-reconnect-error-classification'
import { isHostKeyVerificationError } from '../ssh-host-key-decision'
import { createCancelledConnectAttemptError } from '../ssh-connect-attempt-cancellation'
import {
  didDeferKeyboardInteractive,
  didOfferKeyboardInteractive,
  getPassphrasePrivateKeyPath
} from '../ssh-private-key-authentication'

type EffectiveProxy = ReturnType<typeof resolveEffectiveProxy>

/** The first ssh2 attempt that failed, and what it was dialled with. */
type FailedSsh2Attempt = {
  config: ConnectConfig
  resolved: SshResolvedConfig | null
  effectiveProxy: EffectiveProxy
  skippedIdentityFiles?: SkippedIdentityFiles
}

/** What the fallback ladder reads from and drives on its connection attempt; getters read live state. */
export type Ssh2CredentialFallbackHost = {
  target: SshTarget
  hasCredentialPrompter: () => boolean
  cachedPassphrase: () => string | null
  cachedPassword: () => string | null
  /** Caches a typed passphrase; it stays unproven until the host accepts it. */
  setCachedPassphrase: (value: string) => void
  setCachedPassword: (value: string) => void
  isKeyboardInteractiveCancelled: () => boolean
  isCurrentAttempt: () => boolean
  connect: (config: ConnectConfig) => Promise<void>
  respawnProxy: (config: ConnectConfig, proxy: EffectiveProxy) => void
  killProxyIfCurrent: () => void
  probeSystemSsh: (resolved: SshResolvedConfig | null, gssapiOnly?: boolean) => Promise<void>
  /** System OpenSSH ignores Orca's store, so a host pinned only there must stay on ssh2. */
  isPinnedByOrcaHostKeyStore: () => boolean
  resetSystemTransportIfCurrent: () => void
  requestCredential: (kind: SshCredentialKind, detail: string) => Promise<string | null | undefined>
}

/** False when the user supplied no passphrase; a failed retry throws. */
async function promptPassphraseAndRetry(
  host: Ssh2CredentialFallbackHost,
  retryConfig: ConnectConfig,
  passphraseKeyPath: string | null | undefined,
  resolved: SshResolvedConfig | null,
  effectiveProxy: EffectiveProxy
): Promise<boolean> {
  const detail =
    passphraseKeyPath || host.target.identityFile || resolved?.identityFile?.[0] || '(unknown)'
  const val = await host.requestCredential('passphrase', detail)
  if (!val) {
    return false
  }
  host.setCachedPassphrase(val)
  retryConfig.passphrase = val
  host.respawnProxy(retryConfig, effectiveProxy)
  await host.connect(retryConfig)
  return true
}

/** Walks the transport and credential fallbacks after the first ssh2 attempt fails; resolves once one connects. */
export async function recoverFailedSsh2Attempt(
  err: unknown,
  attempt: FailedSsh2Attempt,
  host: Ssh2CredentialFallbackHost
): Promise<void> {
  const { config, resolved, effectiveProxy, skippedIdentityFiles } = attempt
  if (!(err instanceof Error)) {
    host.killProxyIfCurrent()
    throw err
  }

  // Generation is authoritative: stale verifier denials are unrecorded, so generic handshake errors must not trigger orphan credential/transport fallback.
  if (!host.isCurrentAttempt()) {
    host.killProxyIfCurrent()
    throw err
  }

  // Denied keys are final: credentials could disclose secrets, and system SSH may ignore disagreement with our own trust store.
  if (isHostKeyVerificationError(err)) {
    host.killProxyIfCurrent()
    throw err
  }

  // Cancellation must stop the credential and transport fallback chain.
  if (host.isKeyboardInteractiveCancelled()) {
    host.killProxyIfCurrent()
    throw err
  }

  if (isSystemSshFallbackError(err)) {
    host.killProxyIfCurrent()
    try {
      // Why: on macOS, per-app network policy can block Orca's direct TCP socket while the system OpenSSH binary is still allowed.
      await host.probeSystemSsh(resolved)
      return
    } catch {
      host.resetSystemTransportIfCurrent()
      throw err
    }
  }

  // A pinned host that suddenly shares no algorithm could be an impostor steering Orca away from its pin.
  if (isSsh2AlgorithmNegotiationError(err) && !host.isPinnedByOrcaHostKeyStore()) {
    host.killProxyIfCurrent()
    try {
      await host.probeSystemSsh(resolved)
      return
    } catch (probeErr) {
      host.resetSystemTransportIfCurrent()
      // ssh2 can never reach this host, so the system SSH failure is the one the user can act on.
      throw probeErr
    }
  }

  let authError = err
  let passphrasePromptHandled = false
  let credentialRetryConfig = config

  // ssh2 parses encrypted keys before agent auth; try agent first, then direct key fallback.
  if (isAgentFallbackError(authError) && config.agent && !config.privateKey) {
    const keyConfig = buildConnectConfig(host.target, resolved, {
      includeAgent: false,
      includePrivateKey: true,
      skippedIdentityFiles
    })
    // After agent failure, later credential retries must use the selected key config.
    credentialRetryConfig = keyConfig
    const cachedPassphrase = host.cachedPassphrase()
    if (cachedPassphrase) {
      keyConfig.passphrase = cachedPassphrase
    }
    const cachedPassword = host.cachedPassword()
    if (cachedPassword) {
      keyConfig.password = cachedPassword
    }
    if (keyConfig.privateKey || keyConfig.password) {
      host.respawnProxy(keyConfig, effectiveProxy)
      try {
        await host.connect(keyConfig)
        return
      } catch (keyErr) {
        // A retry can newly deny the host key; stop before the passphrase prompt too.
        if (!(keyErr instanceof Error) || isHostKeyVerificationError(keyErr)) {
          host.killProxyIfCurrent()
          throw keyErr
        }
        // Key fallback must honor the same cancellation boundary.
        if (host.isKeyboardInteractiveCancelled()) {
          host.killProxyIfCurrent()
          throw keyErr
        }
        authError = keyErr
        const passphraseKeyPath = getPassphrasePrivateKeyPath(keyConfig)
        // Try Kerberos before encrypted-key prompts; prompt only if the reactive probe fails.
        if (
          (isPassphraseError(authError) || passphraseKeyPath) &&
          !host.cachedPassphrase() &&
          !isGssapiSystemSshFallbackCandidate(authError, host.target, resolved)
        ) {
          passphrasePromptHandled = true
          if (
            await promptPassphraseAndRetry(
              host,
              keyConfig,
              passphraseKeyPath,
              resolved,
              effectiveProxy
            )
          ) {
            return
          }
        }
        // MaxAuthTries may drop the key retry before its deferred host challenge; offer that challenge alone.
        if (
          isAgentFallbackError(authError) &&
          didDeferKeyboardInteractive(config) &&
          !didOfferKeyboardInteractive(keyConfig)
        ) {
          const challengeConfig = buildConnectConfig(host.target, resolved, {
            keyboardInteractiveOnly: true
          })
          host.respawnProxy(challengeConfig, effectiveProxy)
          try {
            await host.connect(challengeConfig)
            return
          } catch (challengeErr) {
            if (
              !(challengeErr instanceof Error) ||
              isHostKeyVerificationError(challengeErr) ||
              host.isKeyboardInteractiveCancelled()
            ) {
              host.killProxyIfCurrent()
              throw challengeErr
            }
            authError = challengeErr
          }
        }
      }
    }
  }

  // Try Kerberos system SSH before interactive credential fallback.
  if (isGssapiSystemSshFallbackCandidate(authError, host.target, resolved)) {
    host.killProxyIfCurrent()
    try {
      await host.probeSystemSsh(resolved, true)
      return
    } catch {
      host.resetSystemTransportIfCurrent()
    }
    // Publish cancellation, not stale auth failure, when another attempt supersedes the probe.
    if (!host.isCurrentAttempt()) {
      throw createCancelledConnectAttemptError()
    }
  }

  if (!host.hasCredentialPrompter()) {
    host.killProxyIfCurrent()
    throw authError
  }

  // Encrypted-key retries need a fresh proxy socket after ssh2 may have destroyed it.
  const passphraseKeyPath = getPassphrasePrivateKeyPath(credentialRetryConfig)
  if (
    (isPassphraseError(authError) || passphraseKeyPath) &&
    !host.cachedPassphrase() &&
    !passphrasePromptHandled
  ) {
    if (
      await promptPassphraseAndRetry(
        host,
        credentialRetryConfig,
        passphraseKeyPath,
        resolved,
        effectiveProxy
      )
    ) {
      return
    }
  }
  // Agent failures can fall back to password only on the selected no-agent config.
  if (isAgentFallbackError(authError) && !host.cachedPassword()) {
    const val = await host.requestCredential('password', config.host || host.target.label)
    if (val) {
      host.setCachedPassword(val)
      credentialRetryConfig.password = val
      host.respawnProxy(credentialRetryConfig, effectiveProxy)
      await host.connect(credentialRetryConfig)
      return
    }
  }
  host.killProxyIfCurrent()
  throw authError
}
