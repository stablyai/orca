import { describe, expect, it, vi } from 'vitest'
import type { CodexResetCreditAttemptLedger } from '../../shared/codex-reset-credit-attempt-ledger'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import { CodexResetCreditLedger } from './codex-reset-credit-ledger'

function scope(accountId: string): CodexResetCreditExpectedScope {
  return {
    target: { runtime: 'host', wslDistro: null },
    accountId,
    accountRevision: 1,
    offerRevision: 'offer-1'
  }
}

function setup() {
  let durable: CodexResetCreditAttemptLedger = { version: 1, attempts: [] }
  const barrier = vi.fn(async () => {})
  const store = {
    getCodexResetCreditAttemptLedger: () => structuredClone(durable),
    replaceCodexResetCreditAttemptLedgerAndFlush: vi.fn(
      async (next: CodexResetCreditAttemptLedger) => {
        await barrier()
        durable = structuredClone(next)
      }
    )
  }
  return { ledger: new CodexResetCreditLedger(store), store, barrier }
}

describe('async reset-credit ledger', () => {
  it('serializes replacement construction so concurrent account writes survive', async () => {
    const { ledger, store, barrier } = setup()
    const gate = Promise.withResolvers<void>()
    barrier.mockImplementationOnce(() => gate.promise)
    const first = ledger.createFresh('first', scope('account-1'))
    const second = ledger.createFresh('second', scope('account-2'))
    const pendingFirst = ledger.markProviderPending('first', first)
    const pendingSecond = ledger.markProviderPending('second', second)
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledOnce())
    expect(first.state).toBe('fresh')
    expect(second.state).toBe('fresh')
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])

    gate.resolve()
    await Promise.all([pendingFirst, pendingSecond])
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: 'first', state: 'providerPending' },
      { idempotencyKey: 'second', state: 'providerPending' }
    ])
    expect(ledger.getUnresolvedKey(first.accountScopeKey)).toBe('first')
    expect(ledger.getUnresolvedKey(second.accountScopeKey)).toBe('second')
  })

  it('keeps pending guards until settlement commits and can retry a known failure', async () => {
    const { ledger, store, barrier } = setup()
    const attempt = ledger.createFresh('first', scope('account-1'))
    await ledger.markProviderPending('first', attempt)
    const gate = Promise.withResolvers<void>()
    barrier.mockImplementationOnce(() => gate.promise)
    const settled = ledger.markSettled('first', attempt, 'reset')
    const rejected = expect(settled).rejects.toThrow('disk full')
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledTimes(2))
    expect(attempt.state).toBe('providerPending')
    expect(ledger.getUnresolvedKey(attempt.accountScopeKey)).toBe('first')

    gate.reject(new Error('disk full'))
    await rejected
    expect(attempt.state).toBe('providerPending')
    expect(store.getCodexResetCreditAttemptLedger().attempts[0]?.state).toBe('providerPending')
    expect(ledger.error).toBeNull()
    await ledger.markSettled('first', attempt, 'alreadyRedeemed')
    expect(attempt.settledOutcome).toBe('alreadyRedeemed')
    expect(ledger.getUnresolvedKey(attempt.accountScopeKey)).toBeUndefined()
  })

  it('waits for queued writes before removing an account and retains other accounts', async () => {
    const { ledger, store, barrier } = setup()
    const first = ledger.createFresh('first', scope('account-1'))
    const second = ledger.createFresh('second', scope('account-2'))
    await ledger.markProviderPending('first', first)
    const gate = Promise.withResolvers<void>()
    barrier.mockImplementationOnce(() => gate.promise)
    const pendingSecond = ledger.markProviderPending('second', second)
    const removed = ledger.discardForRemovedAccount('account-1')
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledTimes(2))
    expect(ledger.get('first')).toBe(first)

    gate.resolve()
    await Promise.all([pendingSecond, removed])
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: 'second', state: 'providerPending' }
    ])
    expect(ledger.get('first')).toBeUndefined()
    expect(ledger.getUnresolvedKey(first.accountScopeKey)).toBeUndefined()
    expect(ledger.get('second')).toBe(second)
  })

  it('retains the removed account guard when its async durability barrier fails', async () => {
    const { ledger, barrier } = setup()
    const attempt = ledger.createFresh('first', scope('account-1'))
    await ledger.markProviderPending('first', attempt)
    barrier.mockRejectedValueOnce(new Error('disk full'))
    await expect(ledger.discardForRemovedAccount('account-1')).rejects.toThrow('disk full')
    expect(ledger.get('first')).toBe(attempt)
    expect(ledger.getUnresolvedKey(attempt.accountScopeKey)).toBe('first')
  })

  it('fails queued and future mutations closed when a commit outcome is unknown', async () => {
    const { ledger, store, barrier } = setup()
    const attempt = ledger.createFresh('first', scope('account-1'))
    const second = ledger.createFresh('second', scope('account-2'))
    const gate = Promise.withResolvers<void>()
    barrier.mockImplementationOnce(() => gate.promise)
    const pending = ledger.markProviderPending('first', attempt)
    const queued = ledger.markProviderPending('second', second)
    const rejected = expect(pending).rejects.toThrow('worker stopped')
    const blocked = expect(queued).rejects.toThrow('durability is unknown')
    await vi.waitFor(() => expect(barrier).toHaveBeenCalledOnce())
    gate.reject(new ProfileStateWriterError('worker-exit', 'worker stopped', 'indeterminate'))
    await Promise.all([rejected, blocked])

    ledger.releaseFresh('first', attempt)
    expect(ledger.get('first')).toBe(attempt)
    expect(ledger.getClaimedKey(attempt.scopeKey)).toBe('first')
    expect(store.replaceCodexResetCreditAttemptLedgerAndFlush).toHaveBeenCalledOnce()
    await expect(ledger.discardForRemovedAccount('account-1')).rejects.toThrow(
      'durability is unknown'
    )
  })
})
