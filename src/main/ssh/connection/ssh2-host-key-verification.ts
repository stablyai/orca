import type { ConnectConfig } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  createHostKeyVerifier,
  DEFAULT_SERVER_HOST_KEY_ALGORITHMS,
  orderServerHostKeyAlgorithms
} from '../ssh-host-key-verifier'
import { HostKeyVerificationError, hostKeyPolicyForOwner } from '../ssh-host-key-decision'
import {
  siteConfigMayRestrictHostKeys,
  sshGArgsForHost,
  type SshResolvedConfig
} from '../config/ssh-g-config-resolution'
import {
  boundSshHostKeyStoreFile,
  loadTrustedHostKeys,
  matchTrustedHostKeys,
  storedKeyTypesForEndpoint,
  trustHostKey
} from '../ssh-host-key-store'
import {
  loadKnownHostsEvidence,
  resolveKnownHostsFiles,
  resolveKnownHostsLookupHost
} from '../config/ssh-known-hosts-source'

export type HostKeyTrustSources = {
  /** Whether the system-wide ssh_config could be restricting host keys; doubt reads as true. */
  siteMayRestrict: boolean
  knownHostsEvidence: Awaited<ReturnType<typeof loadKnownHostsEvidence>>
  trustedHostKeys: Awaited<ReturnType<typeof loadTrustedHostKeys>>
}

/** Bounds the trust-source reads that run before the handshake, which nothing else times out. */
const HOST_KEY_SOURCE_READ_TIMEOUT_MS = 5_000

/** Reads known_hosts, our store and the site policy for one connect attempt. */
export async function readHostKeyTrustSources(
  hostKeyResolved: SshResolvedConfig | null,
  sshGSuppressedSiteConfig: boolean
): Promise<HostKeyTrustSources> {
  const [siteMayRestrict, knownHostsEvidence, trustedHostKeys] = await Promise.all([
    // Doubt wins on timeout for the same reason it wins on an unreadable file.
    sshGSuppressedSiteConfig
      ? withTimeout(siteConfigMayRestrictHostKeys(), HOST_KEY_SOURCE_READ_TIMEOUT_MS, true)
      : Promise.resolve(false),
    // Why bounded: these reads sit AHEAD of client.connect, and readyTimeout only covers the
    // handshake — nothing else wraps attemptConnect. A home directory on a stalled NFS or SMB
    // mount makes readFile hang indefinitely, which left the connection wedged in `connecting`
    // with no ladder entry and no recovery. The fallback is the one an unreadable file already
    // produces: evidence withheld, so we connect as ssh does but record nothing, rather than the
    // far worse "no hosts known" that would let a changed key through as first contact.
    withTimeout(
      resolveKnownHostsFiles(hostKeyResolved).then(loadKnownHostsEvidence),
      HOST_KEY_SOURCE_READ_TIMEOUT_MS,
      { entries: [], unreadableFileCount: 1 }
    ),
    // The catch sits INSIDE the timeout on purpose: withTimeout absorbs rejections into its
    // fallback, so wrapping the other way round would silently swallow the warning below — the
    // one signal that the store is unwired rather than merely slow.
    withTimeout(
      loadTrustedHostKeys().catch((err) => {
        // Losing our own records is not a security regression: known_hosts is still consulted,
        // so a changed key is still refused. A host trusted only by us degrades to first contact
        // and is re-recorded, which reaches the same decision. Loud because it means the store
        // is unwired.
        console.warn('[ssh] host key store unavailable; falling back to known_hosts only:', err)
        return []
      }),
      HOST_KEY_SOURCE_READ_TIMEOUT_MS,
      []
    )
  ])
  return { siteMayRestrict, knownHostsEvidence, trustedHostKeys }
}

/** What host key verification reads from its connection attempt. */
export type Ssh2HostKeyVerificationHost = {
  target: SshTarget
  hostKeyResolved: SshResolvedConfig | null
  loadTrustSources: (sshGSuppressedSiteConfig: boolean) => Promise<HostKeyTrustSources>
  isCurrentAttempt: () => boolean
  /** An accepted, readable key from the current attempt. */
  onAcceptedFingerprint: (fingerprint: string) => void
}

/** The denial this attempt's verifier recorded; local to one attempt so a stale one cannot leak. */
export type Ssh2HostKeyVerdict = { rejection: HostKeyVerificationError | null }

/** Installs the host verifier and key-type order on `config` before ssh2 dials. */
export async function installSsh2HostKeyVerification(
  config: ConnectConfig,
  host: Ssh2HostKeyVerificationHost
): Promise<Ssh2HostKeyVerdict> {
  const hostKeyResolved = host.hostKeyResolved
  const { host: hostKeyLookupHost, isHostKeyAlias } = resolveKnownHostsLookupHost(
    hostKeyResolved,
    config.host ?? ''
  )
  // `-F` suppresses /etc/ssh/ssh_config, so a site-wide StrictHostKeyChecking is invisible to us
  // on that path. Joined below with the other way a source can go silent: an unreadable file.
  //
  // Gated on `ssh -G` having actually produced something. sshGArgsForHost only reports which args
  // WOULD be used, so without this a machine where ssh is missing, broken or timed out was judged
  // by whether it happens to have a ~/.ssh/config — incoherently, since the same broken machine
  // WITHOUT one was fully permissive. The flag is a claim about a config file we could not read,
  // and when ssh never ran there is no such claim to make.
  const sshGSuppressedSiteConfig =
    hostKeyResolved !== null &&
    sshGArgsForHost(host.target.configHost || host.target.label).includes('-F')
  // Being blind to the site policy is only a reason to refuse if the site config could actually be
  // setting one. ssh cannot answer that — `-F` excludes the system config as surely as the user's,
  // and `-F /dev/null` reports built-in defaults rather than inverting the exclusion — so the file
  // is read instead, conservatively: any doubt keeps the refusal.
  const { siteMayRestrict, knownHostsEvidence, trustedHostKeys } =
    await host.loadTrustSources(sshGSuppressedSiteConfig)
  const siteConfigSuppressed = siteMayRestrict
  const knownHostsEntries = knownHostsEvidence.entries
  // Null means ssh2's own list was unreadable, so there is nothing safe to reorder against and
  // ssh2 keeps proposing whatever it supports.
  const serverHostKeyOrder = DEFAULT_SERVER_HOST_KEY_ALGORITHMS
    ? orderServerHostKeyAlgorithms(
        knownHostsEntries,
        hostKeyLookupHost,
        config.port ?? 22,
        DEFAULT_SERVER_HOST_KEY_ALGORITHMS,
        storedKeyTypesForEndpoint(trustedHostKeys, hostKeyLookupHost, config.port ?? 22),
        isHostKeyAlias
      )
    : undefined
  // Local to this attempt: an instance field would let a superseded attempt's rejection replace
  // the live attempt's error, and substituting a new Error drops ssh2's `code`, so a transient
  // ECONNRESET would stop being classified as retryable.
  const verdict: Ssh2HostKeyVerdict = { rejection: null }

  // Why the fingerprint is still recorded: the relay uses the negotiated server key to isolate
  // shared-home install locks without comparing PIDs from an unrelated SSH host. Its format is
  // load-bearing across versions, which is a second reason never to set ssh2's `hostHash`.
  config.hostVerifier = createHostKeyVerifier({
    host: hostKeyLookupHost,
    port: config.port ?? 22,
    // The name we looked up, not the label: the mismatch message prints `ssh-keygen -R <host>`
    // and a label removes nothing from known_hosts.
    displayHost: hostKeyLookupHost,
    hostKeyStoreFile: boundSshHostKeyStoreFile() ?? undefined,
    strictHostKeyChecking: hostKeyResolved?.strictHostKeyChecking ?? 'ask',
    isHostKeyAlias,
    policy: hostKeyPolicyForOwner(host.target.owner),
    siteConfigSuppressed,
    // A file that EXISTS and will not open is the absence of evidence, not evidence of a new
    // host — the entry that would have said "this key changed" may be in it. An ABSENT file is
    // not this: that is the normal state for a fresh profile and genuinely means nothing is
    // known. The decision connects anyway, as ssh does, but records nothing.
    knownHostsUnreadable: knownHostsEvidence.unreadableFileCount > 0,
    entries: knownHostsEntries,
    // The store's own matcher, against records preloaded above because ssh2's verifier decides
    // synchronously. Reimplementing the comparison here is exactly how the type downgrade got
    // in, and how the host normalisation drifted from the one used to write the records.
    isTrusted: (query) => matchTrustedHostKeys(trustedHostKeys, query),
    rememberHostKey: (record) => {
      void trustHostKey({
        host: record.host,
        port: record.port,
        keyType: record.keyType,
        key: record.key
      }).catch((err) => {
        // A failed write must not fail the connection: we verified the key, we just could not
        // record it, so the next connect re-derives the same answer from known_hosts.
        console.warn('[ssh] failed to record accepted host key:', err)
      })
    },
    isCurrentAttempt: host.isCurrentAttempt,
    onDecision: (decision) => {
      // Empty when the blob was not a readable host key: there is nothing to identify, and the
      // relay uses this fingerprint to isolate install locks, so blanking it would be worse
      // than leaving the previous one. A REJECTED key is excluded for the same reason read the
      // other way: we refused to talk to that host, so adopting its fingerprint would scope the
      // relay's locks to a host we never accepted.
      if (decision.fingerprint && decision.action !== 'reject' && host.isCurrentAttempt()) {
        host.onAcceptedFingerprint(decision.fingerprint)
      }
      if (decision.action === 'reject') {
        verdict.rejection = new HostKeyVerificationError(
          decision.reason ?? 'Host key verification failed.',
          decision.outcome
        )
      }
    }
  })

  if (serverHostKeyOrder) {
    config.algorithms = {
      ...config.algorithms,
      serverHostKey: serverHostKeyOrder as NonNullable<
        NonNullable<ConnectConfig['algorithms']>['serverHostKey']
      >
    }
  }
  return verdict
}
