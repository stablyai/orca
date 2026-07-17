import { loadSshRelayCompiledManifestTrust } from './ssh-relay-compiled-manifest-trust'
import { loadSshRelayPackagedManifest } from './ssh-relay-packaged-manifest'
import type { VerifiedSshRelayArtifactManifest } from './ssh-relay-manifest-signature'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export type SshRelayOfficialManifestLoadOptions = Readonly<{
  packaged: boolean
  resourcesPath: string
  appVersion: string
  relayProtocolVersion: number
}>

export type SshRelayOfficialManifest = Readonly<{
  manifest: VerifiedSshRelayArtifactManifest
  acceptedKeysSha256: SshRelayDigest
}>

export async function loadSshRelayOfficialManifest(
  options: SshRelayOfficialManifestLoadOptions
): Promise<SshRelayOfficialManifest | null> {
  const trust = loadSshRelayCompiledManifestTrust()
  if (trust === null) {
    // Why: an unprovisioned build has no authority to inspect or classify mutable manifest bytes.
    return null
  }
  const manifest = await loadSshRelayPackagedManifest({
    ...options,
    acceptedKeys: trust.acceptedKeys
  })
  return Object.freeze({ manifest, acceptedKeysSha256: trust.acceptedKeysSha256 })
}
