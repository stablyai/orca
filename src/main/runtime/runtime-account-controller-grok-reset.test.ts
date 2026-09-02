import { describe, expect, it, vi } from 'vitest'
import type { GrokResetCreditAttemptLedger } from '../../shared/grok-reset-credit-attempt-ledger'
import { RuntimeAccountController } from './runtime-account-controller'

function createLedgerStore(initial: GrokResetCreditAttemptLedger = { version: 1, attempts: [] }) {
  let ledger: GrokResetCreditAttemptLedger = structuredClone(initial)
  return {
    store: {
      getGrokResetCreditAttemptLedger: vi.fn(() => structuredClone(ledger)),
      replaceGrokResetCreditAttemptLedgerAndFlush: vi.fn((next: GrokResetCreditAttemptLedger) => {
        ledger = structuredClone(next)
      })
    },
    read: () => structuredClone(ledger)
  }
}

function accountServices(
  consumeGrokRateLimitResetCredit: ReturnType<typeof vi.fn>,
  rateLimits: {
    grok: {
      provider: 'grok'
      weekly: { usedPercent: number } | null
      status?: 'ok' | 'error'
    }
  }
) {
  return {
    claudeAccounts: { listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null })) },
    codexAccounts: { listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null })) },
    rateLimits: {
      consumeGrokRateLimitResetCredit,
      refreshGrok: vi.fn(async () => rateLimits),
      getState: vi.fn(() => rateLimits)
    }
  }
}

describe('RuntimeAccountController Grok reset replay', () => {
  it('redeems once when the same idempotency key is retried concurrently or later', async () => {
    const ledger = createLedgerStore()
    const controller = new RuntimeAccountController(() => ledger.store as never)
    const rateLimits = { grok: { provider: 'grok' as const, weekly: { usedPercent: 0 } } }
    const consumeGrokRateLimitResetCredit = vi.fn().mockResolvedValue({
      outcome: 'reset',
      state: rateLimits
    })
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)
    const key = '22222222-2222-4222-8222-222222222222'

    const [first, concurrent] = await Promise.all([
      controller.consumeGrokResetCredit(key),
      controller.consumeGrokResetCredit(key)
    ])
    const later = await controller.consumeGrokResetCredit(key)

    expect(first).toMatchObject({ outcome: 'reset', snapshot: { rateLimits } })
    expect(concurrent).toEqual(first)
    expect(later).toEqual(first)
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce()
  })

  it('replays the same UUID after a simulated host restart without redeeming again', async () => {
    const ledger = createLedgerStore()
    const consumeGrokRateLimitResetCredit = vi.fn().mockResolvedValue({ outcome: 'reset' })
    const rateLimits = { grok: { provider: 'grok' as const, weekly: { usedPercent: 0 } } }
    const key = '33333333-3333-4333-8333-333333333333'
    const firstHost = new RuntimeAccountController(() => ledger.store as never)
    firstHost.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(firstHost.consumeGrokResetCredit(key)).resolves.toMatchObject({ outcome: 'reset' })

    const restartedHost = new RuntimeAccountController(() => ledger.store as never)
    restartedHost.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)
    await expect(restartedHost.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce()
    expect(ledger.read().attempts).toMatchObject([{ idempotencyKey: key, state: 'settled' }])
  })

  it("serializes different UUIDs and replays only each UUID's own result", async () => {
    const ledger = createLedgerStore()
    let resolveProvider!: (value: { outcome: 'reset' }) => void
    const consumeGrokRateLimitResetCredit = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ outcome: 'reset' }>((resolve) => (resolveProvider = resolve))
      )
      .mockResolvedValueOnce({ outcome: 'nothingToReset' })
    const rateLimits = { grok: { provider: 'grok' as const, weekly: { usedPercent: 80 } } }
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)
    const firstKey = '44444444-4444-4444-8444-444444444444'
    const secondKey = '55555555-5555-4555-8555-555555555555'

    const desktop = controller.consumeGrokResetCredit(firstKey)
    const rpc = controller.consumeGrokResetCredit(secondKey)
    await vi.waitFor(() => expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce())
    resolveProvider({ outcome: 'reset' })

    await expect(desktop).resolves.toMatchObject({ outcome: 'reset' })
    await expect(rpc).resolves.toMatchObject({ outcome: 'nothingToReset' })
    await expect(controller.consumeGrokResetCredit(secondKey)).resolves.toMatchObject({
      outcome: 'nothingToReset'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledTimes(2)
    expect(ledger.read().attempts).toMatchObject([
      { idempotencyKey: firstKey, outcome: 'reset' },
      { idempotencyKey: secondKey, outcome: 'nothingToReset' }
    ])
  })

  it('settles a recovered pending attempt when weekly usage was reset', async () => {
    const key = '66666666-6666-4666-8666-666666666666'
    const ledger = createLedgerStore({
      version: 1,
      attempts: [
        {
          idempotencyKey: key,
          state: 'providerPending',
          preOperationWeekly: {
            usedPercent: 80,
            windowMinutes: 10_080,
            resetsAt: null,
            resetDescription: null
          }
        }
      ]
    })
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 0 }, status: 'ok' as const }
    }
    const consumeGrokRateLimitResetCredit = vi.fn()
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consumeGrokRateLimitResetCredit).not.toHaveBeenCalled()
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'settled',
      outcome: 'reset'
    })
  })

  it('retries a transient failure with the same key and settles the provider result', async () => {
    const key = '77777777-7777-4777-8777-777777777777'
    const ledger = createLedgerStore()
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 80 }, status: 'ok' as const }
    }
    const consumeGrokRateLimitResetCredit = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ outcome: 'reset', state: rateLimits })
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).rejects.toThrow('provider unavailable')
    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledTimes(2)
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'settled',
      outcome: 'reset'
    })
  })

  it('discards a fresh pre-provider marker when usage is unavailable and retries the same key', async () => {
    const key = '12121212-1212-4212-8212-121212121212'
    const ledger = createLedgerStore()
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 80 }, status: 'error' as const }
    }
    const consumeGrokRateLimitResetCredit = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'usageUnavailable', state: rateLimits })
      .mockResolvedValueOnce({ outcome: 'reset', state: rateLimits })
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'usageUnavailable'
    })
    expect(ledger.read().attempts).toEqual([])
    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledTimes(2)
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'settled',
      outcome: 'reset'
    })
  })

  it('settles nothingToReset when fresh usage authoritatively reports 0%', async () => {
    const key = '13131313-1313-4313-8313-131313131313'
    const ledger = createLedgerStore()
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 0 }, status: 'ok' as const }
    }
    const consumeGrokRateLimitResetCredit = vi.fn().mockResolvedValue({
      outcome: 'nothingToReset',
      state: rateLimits
    })
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'nothingToReset'
    })
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'settled',
      outcome: 'nothingToReset'
    })
  })

  it('settles alreadyRedeemed when a recovered provider call consumed before the crash', async () => {
    const key = '88888888-8888-4888-8888-888888888888'
    const ledger = createLedgerStore({
      version: 1,
      attempts: [{ idempotencyKey: key, state: 'providerPending' }]
    })
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 80 }, status: 'ok' as const }
    }
    const consumeGrokRateLimitResetCredit = vi.fn().mockResolvedValue({
      outcome: 'alreadyRedeemed',
      state: rateLimits
    })
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'alreadyRedeemed'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce()
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'settled',
      outcome: 'alreadyRedeemed'
    })
  })

  it('keeps a recovered attempt retryable while the provider remains unavailable', async () => {
    const key = '99999999-9999-4999-8999-999999999999'
    const preOperationWeekly = {
      usedPercent: 80,
      windowMinutes: 10_080,
      resetsAt: null,
      resetDescription: null
    }
    const ledger = createLedgerStore({
      version: 1,
      attempts: [{ idempotencyKey: key, state: 'providerPending', preOperationWeekly }]
    })
    const rateLimits = {
      grok: { provider: 'grok' as const, weekly: { usedPercent: 80 }, status: 'error' as const }
    }
    const consumeGrokRateLimitResetCredit = vi.fn().mockResolvedValue({
      outcome: 'usageUnavailable',
      state: rateLimits
    })
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'usageUnavailable'
    })
    await expect(controller.consumeGrokResetCredit(key)).resolves.toMatchObject({
      outcome: 'usageUnavailable'
    })
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledTimes(2)
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'providerPending',
      preOperationWeekly
    })
  })
})
