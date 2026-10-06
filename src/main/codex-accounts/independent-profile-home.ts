// Independent launches materialize resources without touching shared credential provenance.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { codexAuthMatchesManagedAccount, readCodexAuthIdentity } from './codex-auth-identity'
import { hasCodexOAuthCredential } from './managed-codex-auth-readiness'

export function readManagedCodexProfileIdentity(home: string, account: CodexManagedAccount) {
  const authPath = join(home, 'auth.json')
  const contents = lstatSync(authPath).isFile() ? readFileSync(authPath, 'utf8') : ''
  if (!hasCodexOAuthCredential(contents)) {
    throw new Error('Managed Codex credential is unavailable. Reconnect the account.')
  }
  const identity = readCodexAuthIdentity(contents)
  if (!identity?.email || !codexAuthMatchesManagedAccount(contents, account, null)) {
    throw new Error('Managed Codex identity changed or cannot be verified. Reconnect the account.')
  }
  return identity
}
