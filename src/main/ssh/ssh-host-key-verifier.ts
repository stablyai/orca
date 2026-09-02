/**
 * Builds the ssh2 `hostVerifier` and the host-key algorithm order that makes it safe.
 *
 * Separated from `SshConnection` so the decision path can be tested without a handshake, and so the
 * two halves that must ship together — type-scoped matching and algorithm ordering — live in one
 * file where the dependency is visible.
 *
 * See docs/reference/ssh-host-key-verification.md.
 */
import { createHash } from 'node:crypto'
import {
  formatHostKeyFingerprint,
  matchKnownHosts,
  readHostKeyType,
  type KnownHostsEntry,
  type KnownHostsOutcome
} from './ssh-known-hosts'
import { decideHostKey, type HostKeyDecision } from './ssh-host-key-decision'

export type TrustedHostKeyLookup = (query: {
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
  isEphemeralRuntimeTarget: boolean
  siteConfigSuppressed: boolean
  knownHostsUnreadable: boolean
  /** Already unioned across every known_hosts file. */
  entries: readonly KnownHostsEntry[]
  isTrusted: TrustedHostKeyLookup
  /** Passed straight through so a changed-key rejection can name the file to edit. */
  hostKeyStoreFile?: string
  rememberHostKey: (record: {
    host: string
    port: number
    keyType: string
    key: Buffer
    fingerprint: string
  }) => void
  /** Called on every decision so accepts and rejections are auditable. */
  onDecision?: (decision: HostKeyDecision & { fingerprint: string; keyType: string }) => void
  /**
   * False once this connect attempt has been superseded or disposed. A late verifier must deny
   * rather than accept: the attempt it belongs to is gone, so nothing will consume the result, and
   * accepting would record trust on behalf of a connection nobody is waiting for.
   */
  isCurrentAttempt?: () => boolean
}

/**
 * ssh2's own default host-key proposal order, which we reorder rather than replace.
 *
 * Read from ssh2 rather than copied, so we cannot propose an algorithm this ssh2 build does not
 * support and cannot silently drop one it adds. The deep path is the only place ssh2 exports it;
 * ssh2 is an external dependency in the main bundle, so it resolves at runtime from the packaged
 * node_modules rather than being inlined.
 */
export const DEFAULT_SERVER_HOST_KEY_ALGORITHMS = readSsh2DefaultServerHostKeyAlgorithms()

/**
 * Null rather than a copied list when ssh2's own cannot be read.
 *
 * A hardcoded fallback cannot be safe here. ssh2 prepends `ssh-ed25519` only when a RUNTIME PROBE
 * succeeds, and on a build where that probe fails the name is absent from ssh2's SUPPORTED list too,
 * so proposing it makes `generateAlgorithmList` THROW `Unsupported algorithm: ssh-ed25519` inside
 * client.connect. That throw matches no retry classifier, and it would fire only for hosts we
 * already know — working on new hosts and failing on trusted ones. Not reading the list is a reason
 * to leave ssh2's defaults alone, not to guess at them.
 */
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
    // A future ssh2 could move the file. Leaving its defaults keeps connections working; the only
    // cost is that a known host is no longer type-scoped, which is the pre-existing behaviour.
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

/**
 * Host-key algorithms to propose, ordered so the types we already hold for this host come first.
 *
 * This is what makes type-scoped matching safe rather than a downgrade. RFC 4253 gives the client's
 * order priority, so leading with the known types denies a server the choice of presenting some
 * other type to convert a hard failure into first contact. Without this, an attacker who cannot
 * forge the key on file simply offers a different algorithm.
 *
 * Returns undefined when we know nothing for the host, leaving ssh2's defaults alone.
 */
export function orderServerHostKeyAlgorithms(
  entries: readonly KnownHostsEntry[],
  host: string,
  port: number,
  supported: readonly string[],
  /** Types we recorded ourselves. Without these, a host known only to us is never promoted, and
   *  type scoping degrades into the downgrade it exists to prevent for exactly the hosts we
   *  learned on first contact. */
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
  // A known_hosts entry names the KEY type, which is not always the negotiated ALGORITHM name: one
  // `ssh-rsa` key is offered as rsa-sha2-512, rsa-sha2-256 or ssh-rsa depending on the signature
  // algorithm. Promoting only the literal name would leave the RSA host we know behind ed25519,
  // which is the ordering this function exists to prevent.
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

export type VerifyCallback = (accept: boolean) => void

/**
 * The ssh2 `hostVerifier`.
 *
 * MUST be a plain function that returns `undefined`. ssh2 does
 * `const ret = hostVerifier(key, verify); if (ret !== undefined) verify(ret)` — so an `async`
 * function returns a Promise, which is neither undefined nor falsy, and ssh2 accepts the key
 * immediately while ignoring whatever the callback later decides. Making this async would silently
 * restore the accept-everything behaviour this module exists to remove.
 */
export function createHostKeyVerifier(
  deps: HostKeyVerifierDeps
): (key: Buffer, verify: VerifyCallback) => undefined {
  // Every denial must be reported, not just the ones the policy produced: the connect path decides
  // whether to keep offering credentials by looking at the reported decision, so a denial that
  // slipped past onDecision would reach it as ssh2's generic handshake failure and walk the
  // credential ladder against a host we just refused.
  const deny = (verify: VerifyCallback, outcome: KnownHostsOutcome, reason: string): undefined => {
    try {
      deps.onDecision?.({
        action: 'reject',
        outcome,
        reason: `Host key verification failed for ${deps.displayHost}. ${reason}`,
        // Empty: there is no host key here to identify. Consumers must not overwrite a fingerprint
        // they already hold with this.
        fingerprint: '',
        keyType: ''
      })
    } catch {
      // This path already runs from the verifier's own catch; a reporting failure must not become
      // a throw that leaves the handshake hanging instead of denied.
    }
    verify(false)
    return undefined
  }

  return (key, verify) => {
    try {
      if (deps.isCurrentAttempt && !deps.isCurrentAttempt()) {
        // No decision is reported: nobody is waiting on this attempt, and reporting would let a
        // superseded verifier overwrite the live attempt's outcome.
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
        isEphemeralRuntimeTarget: deps.isEphemeralRuntimeTarget,
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
      // `prompt` is unreachable in this phase; treating it as a denial keeps the fail-closed
      // property if it ever becomes reachable before the dialog exists.
      verify(decision.action === 'accept' || decision.action === 'accept-and-remember')
    } catch {
      // ssh2 may not catch a throw from inside the verifier, which would leave the handshake
      // hanging rather than failing. Denying is the only safe outcome for an error we cannot
      // interpret.
      return deny(verify, 'unknown', 'The host key could not be checked.')
    }
    return undefined
  }
}
