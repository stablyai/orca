import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { RateLimitState } from '../../shared/rate-limit-types'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'
import {
  createResetCreditLimits,
  createResetRateLimitState
} from './service-reset-credit-test-fixtures'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

type ConsumeOutcome = { outcome: 'reset' | 'alreadyRedeemed'; state: RateLimitState }

async function createResetService(
  consume: (request: { idempotencyKey: string }) => Promise<ConsumeOutcome>
) {
  const managedHomePath = createManagedHome(testState.userDataDir, 'account-1')
  const account = {
    id: 'account-1',
    email: 'user@example.com',
    managedHomePath,
    managedHomeRuntime: 'host' as const,
    wslDistro: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const settings = createSettings({
    codexManagedAccounts: [account],
    activeCodexManagedAccountId: account.id
  })
  const limits = createResetCreditLimits()
  const state = createResetRateLimitState(limits)
  const scopeFor = () =>
    buildCodexResetCreditExpectedScope({ target: state.codexTarget, account, limits: state.codex })!
  const { CodexAccountService } = await import('./service')
  const service = new CodexAccountService(
    createStore(settings) as never,
    {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    } as never,
    createRuntimeHome() as never
  )
  /** The usage refresh that follows a reset, which moves the offer. */
  const refresh = () => {
    state.codex = { ...state.codex!, updatedAt: state.codex!.updatedAt + 1 }
  }
  return { service, state, scopeFor, refresh }
}

describe('Codex reset retry routing', () => {
  registerCodexAccountsTestHomes()

  it('spends again for a new offer after a settled attempt, never replaying the old one', async () => {
    const consume = vi.fn()
    const { service, state, scopeFor, refresh } = await createResetService(consume)
    consume.mockResolvedValue({ outcome: 'reset', state })
    const firstScope = scopeFor()
    await service.consumeRateLimitResetCredit('d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', firstScope)

    refresh()
    const nextScope = scopeFor()
    expect(nextScope.offerRevision).not.toBe(firstScope.offerRevision)
    await expect(
      service.consumeRateLimitResetCredit('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2', nextScope)
    ).resolves.toMatchObject({ outcome: 'reset', scope: nextScope })
    expect(consume.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
      'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'
    ])
  })

  it('joins a resumed attempt in flight when the retry names a newer offer', async () => {
    const consume = vi.fn()
    const { service, state, scopeFor, refresh } = await createResetService(consume)
    const firstKey = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
    const firstScope = scopeFor()
    consume.mockRejectedValueOnce(new Error('provider response lost'))
    await expect(service.consumeRateLimitResetCredit(firstKey, firstScope)).rejects.toThrow(
      'provider response lost'
    )

    const provider: { finish?: (value: ConsumeOutcome) => void } = {}
    consume.mockImplementationOnce(
      () =>
        new Promise<ConsumeOutcome>((resolve) => {
          provider.finish = resolve
        })
    )
    const resumed = service.consumeRateLimitResetCredit(
      'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2',
      firstScope
    )
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(2))
    refresh()
    const newer = service.consumeRateLimitResetCredit(
      'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3',
      scopeFor()
    )
    provider.finish?.({ outcome: 'alreadyRedeemed', state })

    await expect(Promise.all([resumed, newer])).resolves.toMatchObject([
      { outcome: 'alreadyRedeemed', scope: firstScope },
      { outcome: 'alreadyRedeemed', scope: firstScope }
    ])
    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      firstKey,
      firstKey
    ])
  })
})
