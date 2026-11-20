import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CredentialVault } from './credential-vault'

export type ServerCredentialVault = { scope: string; vault: CredentialVault }
let active: ServerCredentialVault | undefined

export function configureServerCredentialVault(profileDirectory: string): ServerCredentialVault {
  const file = join(profileDirectory, 'server-credential-vault', 'entries.enc')
  active = {
    scope: createHash('sha256').update(file).digest('hex'),
    vault: new CredentialVault(file, true)
  }
  return active
}

export function getServerCredentialVault(scope: string): CredentialVault | undefined {
  return active?.scope === scope ? active.vault : undefined
}
