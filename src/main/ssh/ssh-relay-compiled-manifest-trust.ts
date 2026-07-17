import { parseSshRelayManifestAcceptedKeyDocument } from './ssh-relay-manifest-accepted-keys'
import type { SshRelayManifestAcceptedKey } from './ssh-relay-manifest-signature'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export type SshRelayCompiledManifestTrust = Readonly<{
  acceptedKeys: readonly Readonly<SshRelayManifestAcceptedKey>[]
  acceptedKeysSha256: SshRelayDigest
}>

export function parseSshRelayCompiledManifestTrust(
  document: unknown | null
): SshRelayCompiledManifestTrust | null {
  if (document === null) {
    return null
  }
  const parsed = parseSshRelayManifestAcceptedKeyDocument(document)
  return Object.freeze({
    acceptedKeys: parsed.acceptedKeys,
    acceptedKeysSha256: parsed.sha256
  })
}

export function loadSshRelayCompiledManifestTrust(): SshRelayCompiledManifestTrust | null {
  // Why: official trust roots must be immutable main-bundle inputs; never consult a runtime env or
  // a mutable file beside the untrusted manifest when the build has not provisioned one.
  const document =
    typeof ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS === 'undefined'
      ? null
      : ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS
  return parseSshRelayCompiledManifestTrust(document)
}
