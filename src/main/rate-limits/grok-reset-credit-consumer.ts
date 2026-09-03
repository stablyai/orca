import type { CodexRateLimitResetOutcome } from '../../shared/rate-limit-types'
import { isGrokAccessTokenFresh, readGrokAuthSession } from './grok-auth'
import { consumeGrokRateLimitResetCreditFromRpc } from './grok-reset-credit-client'

export async function consumeGrokRateLimitResetCredit(): Promise<CodexRateLimitResetOutcome> {
  const readResult = readGrokAuthSession()
  if (readResult.status === 'missing') {
    throw new Error('Grok not signed in')
  }
  if (readResult.status === 'error') {
    throw new Error(readResult.error)
  }
  if (!isGrokAccessTokenFresh(readResult.session)) {
    throw new Error(
      'Grok sign-in expired — run grok on the computer running Orca; sign in if prompted. No chat message is needed.'
    )
  }
  return consumeGrokRateLimitResetCreditFromRpc(readResult.session)
}
