import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
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

const fsFaults = vi.hoisted(() => {
  const held = new Set<string>()
  let heldReads = 0
  let mkdirCalls = 0
  return {
    hold(path: string): void {
      held.add(path)
    },
    reset(): void {
      held.clear()
      heldReads = 0
      mkdirCalls = 0
    },
    heldReads(): number {
      return heldReads
    },
    resetMkdirCalls(): void {
      mkdirCalls = 0
    },
    mkdirCalls(): number {
      return mkdirCalls
    },
    noteMkdir(): void {
      mkdirCalls += 1
    },
    consumeLstat(path: unknown): void {
      if (typeof path !== 'string' || !held.has(path)) {
        return
      }
      heldReads += 1
      const error: NodeJS.ErrnoException = new Error(`EPERM: lstat '${path}'`)
      error.code = 'EPERM'
      throw error
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched = {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      fsFaults.consumeLstat(args[0])
      return actual.lstatSync(...args)
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      fsFaults.noteMkdir()
      return actual.mkdirSync(...args)
    }
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('Codex reset-credit managed-home ownership', () => {
  registerCodexAccountsTestHomes()

  it('refuses an indeterminate host home before ledger or provider mutation', async () => {
    const fixture = await createFixture()
    fsFaults.hold(join(realpathSync(fixture.managedHomePath), '.orca-managed-home'))
    fsFaults.resetMkdirCalls()

    await expect(
      fixture.service.consumeRateLimitResetCredit(fixture.idempotencyKey, fixture.expectedScope)
    ).rejects.toThrow('temporarily locked')

    expect(fixture.consume).not.toHaveBeenCalled()
    expect(fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush).not.toHaveBeenCalled()
    expect(fixture.store.updateSettings).not.toHaveBeenCalled()
    expect(fsFaults.mkdirCalls()).toBe(0)
    expect(readFileSync(join(fixture.managedHomePath, 'auth.json'), 'utf-8')).toBe('auth-before')
  })

  it('refuses a proven-untrusted host home before ledger or provider mutation', async () => {
    const fixture = await createFixture()
    writeFileSync(join(fixture.managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')
    fsFaults.resetMkdirCalls()

    await expect(
      fixture.service.consumeRateLimitResetCredit(fixture.idempotencyKey, fixture.expectedScope)
    ).rejects.toThrow('ownership marker does not match')

    expect(fixture.consume).not.toHaveBeenCalled()
    expect(fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush).not.toHaveBeenCalled()
    expect(fixture.store.updateSettings).not.toHaveBeenCalled()
    expect(fsFaults.mkdirCalls()).toBe(0)
  })

  it.each([
    {
      homeState: 'indeterminate',
      expectedError: 'temporarily locked',
      makeHomeUnsafe: (managedHomePath: string) =>
        fsFaults.hold(join(realpathSync(managedHomePath), '.orca-managed-home'))
    },
    {
      homeState: 'proven untrusted',
      expectedError: 'ownership marker does not match',
      makeHomeUnsafe: (managedHomePath: string) =>
        writeFileSync(join(managedHomePath, '.orca-managed-home'), 'someone-else\n', 'utf-8')
    }
  ])(
    'rechecks ownership for a durable providerPending retry when the home is $homeState',
    async ({ expectedError, makeHomeUnsafe }) => {
      const fixture = await createFixture()
      const pendingLedger = {
        version: 1 as const,
        attempts: [
          {
            idempotencyKey: fixture.idempotencyKey,
            expectedScope: fixture.expectedScope,
            state: 'providerPending' as const
          }
        ]
      }
      fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush(pendingLedger)
      makeHomeUnsafe(fixture.managedHomePath)

      const settingsBefore = structuredClone(fixture.store.getSettings())
      const authPath = join(fixture.managedHomePath, 'auth.json')
      const markerPath = join(fixture.managedHomePath, '.orca-managed-home')
      const authBefore = readFileSync(authPath, 'utf-8')
      const markerBefore = readFileSync(markerPath, 'utf-8')
      const directoryEntriesBefore = readdirSync(fixture.managedHomePath).sort()
      fixture.consume.mockClear()
      fixture.store.getCodexResetCreditAttemptLedger.mockClear()
      fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush.mockClear()
      fixture.store.updateSettings.mockClear()
      fsFaults.resetMkdirCalls()

      const restarted = fixture.createService()
      await expect(
        restarted.consumeRateLimitResetCredit(fixture.idempotencyKey, fixture.expectedScope)
      ).rejects.toThrow(expectedError)

      expect(fixture.store.getCodexResetCreditAttemptLedger).toHaveBeenCalledOnce()
      expect(fixture.store.getCodexResetCreditAttemptLedger()).toEqual(pendingLedger)
      expect(fixture.consume).not.toHaveBeenCalled()
      expect(fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush).not.toHaveBeenCalled()
      expect(fixture.store.updateSettings).not.toHaveBeenCalled()
      expect(fixture.store.getSettings()).toEqual(settingsBefore)
      expect(fsFaults.mkdirCalls()).toBe(0)
      expect(readFileSync(authPath, 'utf-8')).toBe(authBefore)
      expect(readFileSync(markerPath, 'utf-8')).toBe(markerBefore)
      expect(readdirSync(fixture.managedHomePath).sort()).toEqual(directoryEntriesBefore)
    }
  )

  it('replays a durable settled outcome without reading a locked managed home', async () => {
    const fixture = await createFixture()
    await expect(
      fixture.service.consumeRateLimitResetCredit(fixture.idempotencyKey, fixture.expectedScope)
    ).resolves.toMatchObject({ outcome: 'reset' })
    fixture.consume.mockClear()
    fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush.mockClear()
    fixture.store.updateSettings.mockClear()
    fsFaults.hold(join(realpathSync(fixture.managedHomePath), '.orca-managed-home'))
    fsFaults.resetMkdirCalls()

    await expect(
      fixture
        .createService()
        .consumeRateLimitResetCredit(fixture.idempotencyKey, fixture.expectedScope)
    ).resolves.toMatchObject({ outcome: 'reset', scope: fixture.expectedScope })

    expect(fsFaults.heldReads()).toBe(0)
    expect(fixture.consume).not.toHaveBeenCalled()
    expect(fixture.store.replaceCodexResetCreditAttemptLedgerAndFlush).not.toHaveBeenCalled()
    expect(fixture.store.updateSettings).not.toHaveBeenCalled()
    expect(fsFaults.mkdirCalls()).toBe(0)
    expect(readFileSync(join(fixture.managedHomePath, 'auth.json'), 'utf-8')).toBe('auth-before')
  })

  async function createFixture() {
    fsFaults.reset()
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-1', '', 'auth-before')
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
      activeCodexManagedAccountId: account.id,
      activeCodexManagedAccountIdsByRuntime: { host: account.id, wsl: {} }
    })
    const store = createStore(settings)
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const consume = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const expectedScope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const { CodexAccountService } = await import('./service')
    const createService = () =>
      new CodexAccountService(store as never, rateLimits as never, createRuntimeHome() as never)
    return {
      service: createService(),
      createService,
      store,
      consume,
      expectedScope,
      managedHomePath,
      idempotencyKey: '11111111-1111-4111-8111-111111111111'
    }
  }
})
