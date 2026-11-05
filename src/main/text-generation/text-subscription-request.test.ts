import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginTextGenerationRequest,
  type TextGenerationRequest
} from './source-control-generation-lanes'
import { runTextSubscriptionRequest } from './text-subscription-request'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'
import type { TextSubscriptionAttempt } from './text-subscription-failover'

const requests: TextGenerationRequest[] = []
afterEach(() => {
  for (const request of requests.splice(0)) {
    request.finish()
  }
})

function account(accountId: string, identity = accountId, valid = () => true) {
  return {
    accountId,
    identity,
    model: 'sonnet',
    env: { ACCOUNT: accountId },
    configurePlan: (plan) => plan,
    valid
  } satisfies TextSubscriptionAttempt
}

const quota: InternalTextGenerationResult = {
  success: false,
  error: 'Claude CLI command failed with code 1.',
  errorCode: 'cliFailed',
  errorParams: { label: 'Claude', exitCode: 1 },
  subscriptionQuotaRefused: true
}

function run(
  accounts: Record<string, TextSubscriptionAttempt | null>,
  ranked: string[],
  outcomes: Record<string, InternalTextGenerationResult>,
  timeoutMs = 60_000
) {
  const request = beginTextGenerationRequest('branch-name', '/repo', timeoutMs, () => true)
  requests.push(request)
  const prepare = vi.fn(async (id: string) => accounts[id] ?? null)
  const executed: string[] = []
  const result = runTextSubscriptionRequest({
    target: {
      kind: 'local',
      cwd: '/repo',
      env: {},
      request,
      subscription: {
        current: () => true,
        params: { agentId: 'claude', model: 'sonnet' },
        initialAccountId: 'a',
        prepare,
        candidates: () => ranked,
        fallbackEnvironment: async () => ({ ORDINARY: '1' })
      }
    },
    execute: async (target) => {
      const id = target.accountAttempt?.accountId ?? 'fallback'
      executed.push(id)
      return outcomes[id] ?? quota
    }
  })
  return { result, prepare, executed, request }
}

describe('subscription failover settlement', () => {
  it('reports exhaustion only when every permitted alternate refused on quota', async () => {
    const { result, executed } = run(
      { a: account('a'), b: account('b'), c: account('c') },
      ['b', 'c'],
      {}
    )
    expect(await result).toMatchObject({
      success: false,
      errorCode: 'subscriptionAccountsExhausted',
      errorParams: { attempted: 3 },
      subscriptionRecovery: { attemptedCount: 3, reason: 'exhausted', firstErrorCode: 'cliFailed' }
    })
    expect(executed).toEqual(['a', 'b', 'c'])
  })

  it('reports the attempt limit when more eligible accounts exist than slots', async () => {
    const { result, executed } = run(
      { a: account('a'), b: account('b'), c: account('c'), d: account('d') },
      ['b', 'c', 'd'],
      {}
    )
    expect(await result).toMatchObject({
      errorCode: 'subscriptionAttemptLimit',
      subscriptionRecovery: { reason: 'attempt-limit' }
    })
    expect(executed).toEqual(['a', 'b', 'c'])
  })

  it('says no eligible alternate, not exhaustion, when an alternate cannot be used', async () => {
    const throwing = account('b', 'b', () => {
      throw new Error('account removed')
    })
    const { result, executed } = run({ a: account('a'), b: throwing }, ['b'], {})
    expect(await result).toMatchObject({
      errorCode: 'subscriptionNoEligibleAlternate',
      subscriptionRecovery: { attemptedCount: 1, reason: 'no-eligible-alternate' }
    })
    expect(executed).toEqual(['a'])
  })

  it('does not spend alternate slots on the initial ID or duplicate IDs', async () => {
    const { result, prepare, executed } = run(
      { a: account('a'), b: account('b'), c: account('c', 'c'), d: account('d') },
      ['a', 'b', 'b', 'c', 'd'],
      { c: { success: true, rawOutput: 'named' } }
    )
    expect(await result).toMatchObject({ success: true, rawOutput: 'named' })
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(executed).toEqual(['a', 'b', 'c'])
  })

  it('an alias of an already used identity still consumes its slot', async () => {
    const { result, executed } = run(
      { a: account('a'), b: account('b', 'a'), c: account('c') },
      ['b', 'c'],
      {}
    )
    expect(await result).toMatchObject({
      errorCode: 'subscriptionAccountsExhausted',
      subscriptionRecovery: { attemptedCount: 2, reason: 'exhausted' }
    })
    expect(executed).toEqual(['a', 'c'])
  })

  it('reports the attempt limit when one slot was skipped and the other refused', async () => {
    const { result, executed } = run(
      { a: account('a'), b: null, c: account('c'), d: account('d') },
      ['b', 'c', 'd'],
      {}
    )
    expect(await result).toMatchObject({
      errorCode: 'subscriptionAttemptLimit',
      subscriptionRecovery: { attemptedCount: 2, reason: 'attempt-limit' }
    })
    expect(executed).toEqual(['a', 'c'])
  })

  it('keeps the first refusal diagnostic on exhaustion', async () => {
    const detailed = { ...quota, errorDetail: 'usage limit reached' }
    const { result } = run({ a: account('a'), b: account('b') }, ['b'], { a: detailed })
    expect(await result).toMatchObject({
      errorCode: 'subscriptionAccountsExhausted',
      errorDetail: 'usage limit reached',
      subscriptionRecovery: { firstErrorCode: 'cliFailed' }
    })
  })

  it('runs the ordinary command when the initial account is not valid', async () => {
    const stale = account('a', 'a', () => false)
    const { result, executed } = run({ a: stale }, [], {
      fallback: { success: true, rawOutput: 'ordinary' }
    })
    expect(await result).toMatchObject({ success: true, rawOutput: 'ordinary' })
    expect(executed).toEqual(['fallback'])
  })

  it('runs the ordinary command when the initial account changes before spawn', async () => {
    const changed: InternalTextGenerationResult = {
      success: false,
      error: 'Generation account changed.',
      subscriptionAccountChanged: true
    }
    const { result, executed } = run({ a: account('a') }, ['b'], {
      a: changed,
      fallback: { success: true, rawOutput: 'ordinary' }
    })
    expect(await result).toMatchObject({ success: true, rawOutput: 'ordinary' })
    expect(executed).toEqual(['a', 'fallback'])
  })

  it('skips an alternate whose account changes before spawn instead of canceling', async () => {
    const changed: InternalTextGenerationResult = {
      success: false,
      error: 'Generation account changed.',
      subscriptionAccountChanged: true
    }
    const { result, executed } = run(
      { a: account('a'), b: account('b'), c: account('c') },
      ['b', 'c'],
      { b: changed, c: { success: true, rawOutput: 'named' } }
    )
    expect(await result).toMatchObject({ success: true, rawOutput: 'named' })
    expect(executed).toEqual(['a', 'b', 'c'])
  })

  it('reports a plain deadline as a timeout, not a budget failure', async () => {
    const { result, executed } = run({ a: account('a') }, [], {}, 0)
    expect(await result).toMatchObject({ success: false, errorCode: 'timedOut' })
    expect(executed).toEqual([])
  })

  it('does not start provider work once the request is aborted', async () => {
    const { result, prepare, request } = run({ a: account('a') }, [], {})
    request.cancel()
    expect(await result).toMatchObject({ canceled: true })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('stops on a non-quota failure from the alternate and reports that failure', async () => {
    const failure: InternalTextGenerationResult = {
      success: false,
      error: 'Claude CLI command failed with code 2.',
      errorCode: 'cliFailed',
      errorParams: { label: 'Claude', exitCode: 2 }
    }
    const { result, executed } = run(
      { a: account('a'), b: account('b'), c: account('c') },
      ['b', 'c'],
      { b: failure }
    )
    expect(await result).toMatchObject({
      ...failure,
      subscriptionRecovery: {
        attemptedCount: 2,
        reason: 'non-quota-failure',
        firstError: quota.error
      }
    })
    expect(executed).toEqual(['a', 'b'])
  })

  it('reports budget-ended instead of preparing an alternate once the spawn cap is spent', async () => {
    const { result, prepare, executed, request } = run(
      { a: account('a'), b: account('b') },
      ['b'],
      {}
    )
    for (let spawn = 0; spawn < 9; spawn++) {
      request.claimSpawn()
    }
    expect(await result).toMatchObject({
      errorCode: 'subscriptionBudgetEnded',
      subscriptionRecovery: {
        attemptedCount: 1,
        reason: 'budget-ended',
        firstErrorCode: 'cliFailed'
      }
    })
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a'])
    expect(executed).toEqual(['a'])
  })

  it('reports budget-ended when the spawn cap refuses an alternate run', async () => {
    const refused: InternalTextGenerationResult = {
      success: false,
      error: 'Generation attempt budget ended.',
      errorCode: 'generationAttemptBudgetEnded'
    }
    const { result, executed, request } = run(
      { a: account('a'), b: account('b'), c: account('c') },
      ['b', 'c'],
      { b: refused }
    )
    for (let spawn = 0; spawn < 7; spawn++) {
      request.claimSpawn()
    }
    expect(await result).toMatchObject({
      errorCode: 'subscriptionBudgetEnded',
      subscriptionRecovery: { reason: 'budget-ended', firstErrorCode: 'cliFailed' }
    })
    expect(executed).toEqual(['a', 'b'])
  })
})
