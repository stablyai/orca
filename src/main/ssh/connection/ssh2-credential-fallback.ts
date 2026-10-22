import type { ConnectConfig } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import type { SshCredentialKind } from './ssh-connection-callbacks'
import { buildConnectConfig } from './ssh-connect-config'
import type { resolveEffectiveProxy } from '../ssh-proxy-command'
import {
  isAgentFallbackError,
  isGssapiSystemSshFallbackCandidate,
  isPassphraseError,
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
  const { config, resolved, effectiveProxy } = attempt
  if (!(err instanceof Error)) {
    host.killProxyIfCurrent()
    throw err
  }

  // Why generation and not the error: a superseded attempt's host key denial is deliberately
  // NOT recorded — the verifier withholds it so a dead attempt cannot clobber the live one's
  // outcome — so nothing about the error identifies it, and ssh2's generic handshake failure
  // reads as an ordinary fault. Everything below either offers a credential or probes another
  // transport, and doing that for a connection nobody is waiting on can put a passphrase prompt
  // in front of a host we just refused. Checking the generation catches it whatever the error
  // turned out to be, and leaves what connect() rejects with unchanged.
  if (!host.isCurrentAttempt()) {
    host.killProxyIfCurrent()
    throw err
  }

  // Why first: everything below this line either offers a credential or retries on another
  // transport. We have just decided this host may not be the one it claims to be, so prompting
  // would collect the user's passphrase or password on its behalf, and the system-ssh probe
  // would connect anyway whenever the disagreement is with our own store rather than
  // known_hosts. A denied key is final for this attempt.
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

  let authError = err
  let passphrasePromptHandled = false
  let credentialRetryConfig = config

  // Why: ssh2 parses encrypted privateKey before agent auth; when an agent exists, let it try first and fall back to direct key parsing only if it fails.
  if (isAgentFallbackError(authError) && config.agent && !config.privateKey) {
    const keyConfig = buildConnectConfig(host.target, resolved, {
      includeAgent: false,
      includePrivateKey: true
    })
    // Why: if the agent path failed, password/passphrase retries must not reuse the same agent-only config.
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
        // Same reason as above: the retry re-runs the handshake, so it can be the attempt that
        // denies the key, and the passphrase prompt is directly below.
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
        // Why: with GSSAPI enabled, let the reactive system-ssh probe try a Kerberos ticket before prompting for the passphrase; the prompt still runs if it fails.
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
        // Why: a strict MaxAuthTries host can drop the key retry before it reaches the challenge
        // the agent-first attempt held back for that key, so offer the challenge on its own.
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

  // Why: a Kerberos ticket may authenticate where keys did not; try the system ssh binary before falling back to interactive prompts.
  if (isGssapiSystemSshFallbackCandidate(authError, host.target, resolved)) {
    host.killProxyIfCurrent()
    try {
      await host.probeSystemSsh(resolved, true)
      return
    } catch {
      host.resetSystemTransportIfCurrent()
    }
    // Why: if a disconnect/reconnect superseded this attempt mid-probe, throw the cancellation error (not the stale authError) so connect() doesn't post auth-failed.
    if (!host.isCurrentAttempt()) {
      throw createCancelledConnectAttemptError()
    }
  }

  if (!host.hasCredentialPrompter()) {
    host.killProxyIfCurrent()
    throw authError
  }

  // Why: prompt for passphrase on encrypted-key error, then retry with a fresh proxy socket (ssh2 may have destroyed the original).
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
  // Why: an agent socket failure can still be recovered by password auth, but the retry must use the no-agent config selected above.
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
