import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type { CodexManagedHomeLifecycle as ManagedHomeLifecycle } from '../managed-homes/codex-managed-home-lifecycle'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock(import('node:os'), async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../login/codex-login-session', () => ({
  runCodexLoginSession: async () => {
    throw new Error('An obsolete request reached interactive login.')
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))
registerCodexAccountsTestHomes()

it('imports the chosen credentials instead of starting an older login still preparing its home', async () => {
  const { CodexManagedHomeLifecycle } =
    await import('../managed-homes/codex-managed-home-lifecycle')
  const { CodexAccountService } = await import('../service')
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const create = CodexManagedHomeLifecycle.prototype.create
  const delayed = vi
    .spyOn(CodexManagedHomeLifecycle.prototype, 'create')
    .mockImplementationOnce(async function (this: ManagedHomeLifecycle, ...args) {
      const home = await create.apply(this, args)
      ready.resolve()
      await release.promise
      return home
    })
  const store = createStore(createSettings())
  const service = new CodexAccountService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness implements the registration store operations.
    store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness implements the account-change rate-limit operations.
    createRateLimits() as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness implements registration's runtime-home operations.
    createRuntimeHome() as never
  )
  const source = join(testState.fakeHomeDir, '.codex')
  const auth = createCodexAuthJson('imported@example.com', 'imported-account', 'imported-refresh')
  writeFileSync(join(source, 'auth.json'), auth)
  try {
    const oldLogin = service.addAccount().catch((error: unknown) => error)
    await ready.promise
    const imported = service.addAccountFromHome(source, { runtime: 'host' })
    release.resolve()
    const [cancelled, state] = await Promise.all([oldLogin, imported])
    expect(cancelled).toMatchObject({ message: 'Codex sign-in was cancelled.' })
    expect(state.accounts.map((account) => account.email)).toEqual(['imported@example.com'])
    expect(store.getSettings().codexManagedAccounts.map((account) => account.email)).toEqual([
      'imported@example.com'
    ])
    expect(readFileSync(join(source, 'auth.json'), 'utf8')).toBe(auth)
  } finally {
    release.resolve()
    delayed.mockRestore()
  }
})
