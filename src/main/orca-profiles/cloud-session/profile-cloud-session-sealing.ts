import {
  getSecretStore,
  hasSecretStore,
  type SecretStore
} from '../../../shared/secure-storage/secret-store'

export class OrcaCloudSessionStorageRefusedError extends Error {
  constructor(reason: string) {
    super(`Orca can't save your sign-in on this host: ${reason}`)
    this.name = 'OrcaCloudSessionStorageRefusedError'
  }
}

/** The reason storage is too weak for a caller that requires a seal, or null when sealed. */
export function sealedStorageRefusal(
  secrets: SecretStore | null = currentSecretStore()
): string | null {
  if (!secrets) {
    return 'this host has no credential store.'
  }
  const sealing = secrets.describeSealing?.()
  if (sealing?.kind === 'none') {
    return sealing.reason
  }
  return !secrets.isEncryptionAvailable() || !sealing ? 'this host cannot seal credentials.' : null
}

function currentSecretStore(): SecretStore | null {
  return hasSecretStore() ? getSecretStore() : null
}
