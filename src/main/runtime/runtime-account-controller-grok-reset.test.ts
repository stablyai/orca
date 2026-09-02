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

  it('coalesces concurrent desktop and RPC attempts with different UUIDs', async () => {
    const ledger = createLedgerStore()
    let resolveProvider!: (value: { outcome: 'reset' }) => void
    const consumeGrokRateLimitResetCredit = vi.fn(
      () => new Promise<{ outcome: 'reset' }>((resolve) => (resolveProvider = resolve))
    )
    const rateLimits = { grok: { provider: 'grok' as const, weekly: { usedPercent: 80 } } }
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    const desktop = controller.consumeGrokResetCredit('44444444-4444-4444-8444-444444444444')
    const rpc = controller.consumeGrokResetCredit('55555555-5555-4555-8555-555555555555')
    resolveProvider({ outcome: 'reset' })

    await expect(Promise.all([desktop, rpc])).resolves.toMatchObject([
      { outcome: 'reset' },
      { outcome: 'reset' }
    ])
    expect(consumeGrokRateLimitResetCredit).toHaveBeenCalledOnce()
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

  it('keeps a recovered pending attempt unknown when weekly usage is unchanged', async () => {
    const key = '77777777-7777-4777-8777-777777777777'
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
      grok: { provider: 'grok' as const, weekly: { usedPercent: 80 }, status: 'ok' as const }
    }
    const consumeGrokRateLimitResetCredit = vi.fn()
    const controller = new RuntimeAccountController(() => ledger.store as never)
    controller.setServices(accountServices(consumeGrokRateLimitResetCredit, rateLimits) as never)

    await expect(controller.consumeGrokResetCredit(key)).rejects.toThrow(/unknown outcome/)
    expect(consumeGrokRateLimitResetCredit).not.toHaveBeenCalled()
    expect(ledger.read().attempts).toContainEqual({
      idempotencyKey: key,
      state: 'providerPending',
      preOperationWeekly
    })
  })
})
