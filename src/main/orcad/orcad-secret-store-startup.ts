import { join } from 'node:path'
import { prepareOrcadSecretStore } from './orcad-host-adapters'

export async function prepareOrcadSecretStoreAndMigrate(userDataPath: string): Promise<void> {
  const { getSecretStore } = await import('../../shared/secret-store')
  const { reportSecretProtectionGap } = await import('../host/secret-protection-report')
  const { migratePlaintextCredentials, orcadCredentialRoot } =
    await import('./orcad-plaintext-credential-migration')
  // Why the credential root, not userData: a disposable ORCA_USER_DATA would take the key with it.
  if (await prepareOrcadSecretStore(orcadCredentialRoot(), userDataPath)) {
    migratePlaintextCredentials(getSecretStore())
  }
  reportSecretProtectionGap({ dataFile: join(userDataPath, 'orca-data.json') })
}
