import type { AccountsSnapshot } from './accounts-snapshot'

export function getDeepSeekBalanceState(snapshot: AccountsSnapshot) {
  const account = snapshot.rateLimits.deepseekAccount
  if (!account?.supported || !account.configured || !account.ownerId) {
    return null
  }
  const limits = snapshot.rateLimits.deepseek
  const balance = limits?.balance ?? null
  const messages: string[] = []
  if (!balance) {
    messages.push(
      limits?.status === 'fetching' || limits?.status === 'idle'
        ? 'Checking balance…'
        : 'Balance unavailable'
    )
  } else {
    if (!balance.is_available) {
      messages.push('DeepSeek reports insufficient balance for API calls.')
    }
    if (limits?.status === 'error') {
      messages.push('Refresh failed — showing the last balance.')
    }
  }
  return { balance, messages }
}
