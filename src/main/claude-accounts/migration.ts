// Why: legacy Claude managed accounts on disk predate the discriminated
// `credentials` union, `modelMapping`, and `fallbackAccountIds`. We synthesize
// those fields lazily on read/mutation so users don't lose their saved logins.
import type { ClaudeAuthCredentials, ClaudeManagedAccount } from '../../shared/types'

type LegacyAccount = Omit<
  ClaudeManagedAccount,
  'credentials' | 'modelMapping' | 'fallbackAccountIds'
> &
  Partial<Pick<ClaudeManagedAccount, 'credentials' | 'modelMapping' | 'fallbackAccountIds'>>

function deriveCredentials(authMethod: LegacyAccount['authMethod']): ClaudeAuthCredentials {
  if (authMethod === 'subscription-oauth') return { authMethod: 'subscription-oauth' }
  if (authMethod === 'anthropic-api-key') return { authMethod: 'anthropic-api-key' }
  return { authMethod: 'unknown' }
}

export function migrateClaudeAccount(
  input: LegacyAccount | ClaudeManagedAccount
): ClaudeManagedAccount {
  return {
    ...input,
    credentials: input.credentials ?? deriveCredentials(input.authMethod),
    modelMapping: input.modelMapping ?? {},
    fallbackAccountIds: input.fallbackAccountIds ?? []
  }
}

export function migrateClaudeAccountList(
  input: Array<LegacyAccount | ClaudeManagedAccount>
): ClaudeManagedAccount[] {
  return input.map(migrateClaudeAccount)
}
