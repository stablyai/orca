import type { ClaudeRateLimitAccountsState } from '../shared/types'
import { RuntimeClientError } from './runtime-client'

export function resolveClaudeAccountId(
  snapshot: ClaudeRateLimitAccountsState,
  selector: string | null
): string | null {
  if (selector === null) {
    return null
  }
  const idMatch = snapshot.accounts.find((account) => account.id === selector)
  if (idMatch) {
    return idMatch.id
  }
  const emailMatches = snapshot.accounts.filter(
    (account) => account.email.toLowerCase() === selector.toLowerCase()
  )
  if (emailMatches.length === 1) {
    return emailMatches[0].id
  }
  if (emailMatches.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Account selector "${selector}" matches multiple accounts; use an account id.`
    )
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Claude account "${selector}" was not found. Run "orca account list" to see available accounts.`
  )
}
