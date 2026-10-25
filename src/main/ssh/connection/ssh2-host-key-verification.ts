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
    // Bound pre-handshake NFS/SMB reads separately from readyTimeout. On silence retain unreadable evidence: connect without recording trust, never pretend all hosts are unknown.
    withTimeout(
      resolveKnownHostsFiles(hostKeyResolved).then(loadKnownHostsEvidence),
      HOST_KEY_SOURCE_READ_TIMEOUT_MS,
      { entries: [], unreadableFileCount: 1 }
    ),
    // Catch inside withTimeout so its rejection fallback cannot swallow the unwired-store warning.
    withTimeout(
      loadTrustedHostKeys().catch((err) => {
        // Warn loudly on unwired store; known_hosts still applies, while store-only hosts return to first contact.
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
type Ssh2HostKeyVerificationHost = {
  target: SshTarget
  hostKeyResolved: SshResolvedConfig | null
  loadTrustSources: (sshGSuppressedSiteConfig: boolean) => Promise<HostKeyTrustSources>
  isCurrentAttempt: () => boolean
  /** An accepted, readable key from the current attempt. */
  onAcceptedFingerprint: (fingerprint: string) => void
}

/** The denial this attempt's verifier recorded; local to one attempt so a stale one cannot leak. */
type Ssh2HostKeyVerdict = { rejection: HostKeyVerificationError | null }

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
  // Only successful ssh -G output can claim -F hid site config; missing/broken probes must not invent suppression from argv alone.
  const sshGSuppressedSiteConfig =
    hostKeyResolved !== null &&
    sshGArgsForHost(host.target.configHost || host.target.label).includes('-F')
  // Inspect site config conservatively: -F excludes it and /dev/null cannot recover it; any uncertainty retains refusal.
  const { siteMayRestrict, knownHostsEvidence, trustedHostKeys } =
    await host.loadTrustSources(sshGSuppressedSiteConfig)
  const siteConfigSuppressed = siteMayRestrict
  const knownHostsEntries = knownHostsEvidence.entries
  // If ssh2's own algorithm list is unreadable, keep its defaults rather than guessing a reorder.
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
  // Keep denial attempt-local and retain original ssh2 error codes so stale attempts and transient failures stay distinguishable.
  const verdict: Ssh2HostKeyVerdict = { rejection: null }

  // Accepted server fingerprints isolate shared-home relay locks across hosts; preserve mixed-version format and leave hostHash unset.
  config.hostVerifier = createHostKeyVerifier({
    host: hostKeyLookupHost,
    port: config.port ?? 22,
    // Print the lookup host in ssh-keygen -R guidance; the Orca label would remove no trusted entry.
    displayHost: hostKeyLookupHost,
    hostKeyStoreFile: boundSshHostKeyStoreFile() ?? undefined,
    strictHostKeyChecking: hostKeyResolved?.strictHostKeyChecking ?? 'ask',
    isHostKeyAlias,
    policy: hostKeyPolicyForOwner(host.target.owner),
    siteConfigSuppressed,
    // Existing unreadable sources withhold evidence; connect as SSH does but record nothing. Absent files remain normal first-contact evidence.
    knownHostsUnreadable: knownHostsEvidence.unreadableFileCount > 0,
    entries: knownHostsEntries,
    // Use the store matcher on preloaded records; duplicating it risks downgrade/normalization drift inside the synchronous verifier.
    isTrusted: (query) => matchTrustedHostKeys(trustedHostKeys, query),
    rememberHostKey: (record) => {
      void trustHostKey({
        host: record.host,
        port: record.port,
        keyType: record.keyType,
        key: record.key
      }).catch((err) => {
        // Recording failure cannot revoke a verified connection; later connects derive trust again.
        console.warn('[ssh] failed to record accepted host key:', err)
      })
    },
    isCurrentAttempt: host.isCurrentAttempt,
    onDecision: (decision) => {
      // Only readable accepted keys from the current attempt may scope relay locks; rejected or malformed keys must not replace the prior fingerprint.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every name is drawn from ssh2's runtime DEFAULT_SERVER_HOST_KEY list (a subset of what it supports), which the @types/ssh2 literal union lags.
      serverHostKey: serverHostKeyOrder as NonNullable<
        NonNullable<ConnectConfig['algorithms']>['serverHostKey']
      >
    }
  }
  return verdict
}
