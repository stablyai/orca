import { getSecretStore } from '../../shared/secret-store'

export type ProtectedDatabaseVaultKey = {
  protection: 'os' | 'local-file'
  payload: string
}

export type DatabaseVaultKeyProtection = {
  protect: (key: Buffer) => ProtectedDatabaseVaultKey
  unprotect: (stored: ProtectedDatabaseVaultKey) => Buffer
}

export class HostDatabaseVaultKeyProtection implements DatabaseVaultKeyProtection {
  protect(key: Buffer): ProtectedDatabaseVaultKey {
    if (canUseOsKeyProtection()) {
      return {
        protection: 'os',
        payload: getSecretStore().encryptString(key.toString('base64')).toString('base64')
      }
    }
    // Why: headless Linux commonly has no Secret Service. A current-user-only
    // key file keeps the vault usable without silently selecting basic_text.
    return { protection: 'local-file', payload: key.toString('base64') }
  }

  unprotect(stored: ProtectedDatabaseVaultKey): Buffer {
    if (stored.protection === 'local-file') {
      return Buffer.from(stored.payload, 'base64')
    }
    if (!canUseOsKeyProtection()) {
      throw new Error('The operating system credential store is unavailable')
    }
    return Buffer.from(
      getSecretStore().decryptString(Buffer.from(stored.payload, 'base64')),
      'base64'
    )
  }
}

function canUseOsKeyProtection(): boolean {
  const secrets = getSecretStore()
  return secrets.isEncryptionAvailable() && secrets.describeProtectionGap() === null
}
