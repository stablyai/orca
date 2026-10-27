/** Keep type-scoped matching and proposal ordering together; ordering known types first prevents alternate-type downgrade to first contact. */
import { createHash } from 'node:crypto'
import {
  formatHostKeyFingerprint,
  matchKnownHosts,
  readHostKeyType,
  type KnownHostsEntry,
  type KnownHostsOutcome
} from './config/ssh-known-hosts'
import { decideHostKey, type HostKeyDecision, type HostKeyPolicy } from './ssh-host-key-decision'

type TrustedHostKeyLookup = (query: {
  host: string
  port: number
  keyType: string
  key: Buffer
}) => 'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'

export type HostKeyVerifierDeps = {
  host: string
  port: number
  displayHost: string
  /** True when `host` came from HostKeyAlias; ssh looks those up without the port. */
  isHostKeyAlias?: boolean
  strictHostKeyChecking: string
  policy: HostKeyPolicy
  siteConfigSuppressed: boolean
  knownHostsUnreadable: boolean
  entries: readonly KnownHostsEntry[]
  isTrusted: TrustedHostKeyLookup
  hostKeyStoreFile?: string
  rememberHostKey: (record: {
    host: string
    port: number
    keyType: string
    key: Buffer
    fingerprint: string
  }) => void
  onDecision?: (decision: HostKeyDecision & { fingerprint: string; keyType: string }) => void
  /** Superseded attempts must deny without recording trust for a connection nobody awaits. */
  isCurrentAttempt?: () => boolean
}

/** Read packaged ssh2 defaults at runtime so proposals track supported algorithms instead of a stale copy. */
export const DEFAULT_SERVER_HOST_KEY_ALGORITHMS = readSsh2DefaultServerHostKeyAlgorithms()

/** Return null when defaults cannot be read: runtime probes can remove algorithms, so guessed lists may throw only for trusted hosts. */
function readSsh2DefaultServerHostKeyAlgorithms(): string[] | null {
  try {
    const constants = require('ssh2/lib/protocol/constants.js') as {
      DEFAULT_SERVER_HOST_KEY?: unknown
    }
    const list = constants?.DEFAULT_SERVER_HOST_KEY
    if (Array.isArray(list) && list.length > 0 && list.every((a) => typeof a === 'string')) {
      return [...(list as string[])]
    }
    console.warn('[ssh] ssh2 default host key list has an unexpected shape; leaving its defaults')
  } catch (error) {
    // If ssh2 moves its private export, leave defaults unchanged rather than propose unsupported algorithms.
    console.warn(
      '[ssh] could not read ssh2 default host key algorithms; leaving its defaults:',
      error
    )
  }
  return null
}

export function hostKeyFingerprintOf(key: Buffer): string {
  return formatHostKeyFingerprint(createHash('sha256').update(key).digest('base64'))
}

/** RFC 4253 prioritizes client order: promote known key types so a server cannot choose an unfamiliar type to evade mismatch. Unknown hosts retain defaults. */
export function orderServerHostKeyAlgorithms(
  entries: readonly KnownHostsEntry[],
  host: string,
  port: number,
  supported: readonly string[],
  /** Include store-only known types or first-contact trust would lack downgrade protection. */
  storedKeyTypes: readonly string[] = [],
  isHostKeyAlias = false
): string[] | undefined {
  const known = new Set<string>(storedKeyTypes)
  for (const entry of entries) {
    if (entry.marker === 'revoked') {
      continue
    }
    // Reuse the matcher's own host logic rather than re-implementing pattern/hash matching here.
    const outcome = matchKnownHosts([entry], {
      host,
      port,
      keyType: entry.keyType,
      key: entry.key,
      isHostKeyAlias
    })
    if (outcome === 'match') {
      known.add(entry.keyType)
    }
  }
  if (known.size === 0) {
    return undefined
  }
  // Promote every negotiated signature alias for ssh-rsa, not just its literal key type.
  const preferred = supported.filter(
    (algorithm) =>
      known.has(algorithm) || (known.has('ssh-rsa') && algorithm.startsWith('rsa-sha2-'))
  )
  if (preferred.length === 0) {
    return undefined
  }
  const preferredSet = new Set(preferred)
  return [...preferred, ...supported.filter((algorithm) => !preferredSet.has(algorithm))]
}

type VerifyCallback = (accept: boolean) => void

/** Return undefined synchronously: ssh2 accepts any non-undefined return, so an async Promise would bypass the verification callback. */
export function createHostKeyVerifier(
  deps: HostKeyVerifierDeps
): (key: Buffer, verify: VerifyCallback) => undefined {
  // Report every denial so generic handshake errors cannot trigger credential prompts for a refused host.
  const deny = (verify: VerifyCallback, outcome: KnownHostsOutcome, reason: string): undefined => {
    try {
      deps.onDecision?.({
        action: 'reject',
        outcome,
        reason: `Host key verification failed for ${deps.displayHost}. ${reason}`,
        // Empty fingerprint signals no usable key; consumers must retain prior valid identity.
        fingerprint: '',
        keyType: ''
      })
    } catch {
      // Reporting failure must still reach verify(false), never hang the handshake.
    }
    verify(false)
    return undefined
  }

  return (key, verify) => {
    try {
      if (deps.isCurrentAttempt && !deps.isCurrentAttempt()) {
        // Silently deny stale attempts so they cannot overwrite their replacement's trust decision.
        verify(false)
        return undefined
      }
      const keyType = readHostKeyType(key)
      if (!keyType) {
        // A key whose own header we cannot read is not something to reason about further.
        return deny(
          verify,
          'unknown',
          'The host offered a key that could not be read as an SSH host key.'
        )
      }
      const fingerprint = hostKeyFingerprintOf(key)
      const decision = decideHostKey({
        knownHostsOutcome: matchKnownHosts(deps.entries, {
          host: deps.host,
          port: deps.port,
          keyType,
          key,
          isHostKeyAlias: deps.isHostKeyAlias
        }),
        storeOutcome: deps.isTrusted({ host: deps.host, port: deps.port, keyType, key }),
        strictHostKeyChecking: deps.strictHostKeyChecking,
        policy: deps.policy,
        siteConfigSuppressed: deps.siteConfigSuppressed,
        knownHostsUnreadable: deps.knownHostsUnreadable,
        displayHost: deps.displayHost,
        port: deps.port,
        hostKeyStoreFile: deps.hostKeyStoreFile
      })

      deps.onDecision?.({ ...decision, fingerprint, keyType })

      if (decision.action === 'accept-and-remember') {
        deps.rememberHostKey({
          host: deps.host,
          port: deps.port,
          keyType,
          key,
          fingerprint
        })
      }
      // Deny future prompt actions until their UI is implemented.
      verify(decision.action === 'accept' || decision.action === 'accept-and-remember')
    } catch {
      // Contain dependency throws and deny; ssh2 may otherwise leave handshake hanging.
      return deny(verify, 'unknown', 'The host key could not be checked.')
    }
    return undefined
  }
}
