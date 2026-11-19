import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock(import('node:os'), async (original) => ({
  ...(await original()),
  homedir: () => testState.fakeHomeDir
}))

beforeEach(() => {
  setupRuntimeHomeTest()
  installFakeAppEnvironment({ getPath: () => testState.userDataDir })
})
afterEach(() => teardownRuntimeHomeTest())

it('launches workspace accounts in separate homes while other workspaces inherit the host account', async () => {
  const authA = createCodexAuthJson('a@example.com', 'provider-a', 'a')
  const authB = createCodexAuthJson('b@example.com', 'provider-b', 'b')
  const homeA = createManagedAuth(testState.userDataDir, 'account-a', authA)
  const homeB = createManagedAuth(testState.userDataDir, 'account-b', authB)
  const settings = createSettings({
    realHomeRoutable: true,
    codexManagedAccounts: [
      {
        id: 'account-a',
        email: 'a@example.com',
        managedHomePath: homeA,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      },
      {
        id: 'account-b',
        email: 'b@example.com',
        managedHomePath: homeB,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeCodexManagedAccountId: 'account-a',
    activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} },
    codexWorkspaceAccounts: { 'folder:client': 'account-b', 'project::C:/work/client': 'account-b' }
  })
  const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
  const store = createStore(settings)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the store methods exercised by runtime-home routing.
  const service = new CodexRuntimeHomeService(store as never)

  expect(
    service.prepareForCodexLaunch(undefined, undefined, { workspaceId: 'folder:client' })
  ).toBe(homeB)
  expect(
    service.prepareForCodexLaunch(undefined, undefined, {
      workspaceId: 'worktree:project::C:/work/client'
    })
  ).toBe(homeB)
  expect(service.resolveHostCodexHomePathForLaunchReadOnly(undefined, 'folder:client')).toBe(homeB)
  expect(
    service.prepareForCodexLaunch(undefined, undefined, { workspaceId: 'folder:personal' })
  ).toBe(homeA)
  expect(readFileSync(join(homeA, 'auth.json'), 'utf8')).toBe(authA)
  expect(readFileSync(join(homeB, 'auth.json'), 'utf8')).toBe(authB)
  expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')

  store.updateSettings({ codexWorkspaceAccounts: { 'folder:system': 'system-default' } })
  expect(
    await service.prepareForCodexLaunchAsync(undefined, undefined, { workspaceId: 'folder:system' })
  ).toBe(join(testState.fakeHomeDir, '.codex'))
  expect(service.resolveHostCodexHomePathForLaunchReadOnly(undefined, 'folder:system')).toBe(
    join(testState.fakeHomeDir, '.codex')
  )
  expect(store.getSettings().activeCodexManagedAccountId).toBe('account-a')
  store.updateSettings({ codexWorkspaceAccounts: { 'folder:client': 'account-b' } })

  store.updateSettings({
    codexManagedAccounts: store
      .getSettings()
      .codexManagedAccounts.filter((account) => account.id !== 'account-b')
  })
  expect(() =>
    service.prepareForCodexLaunch(undefined, undefined, { workspaceId: 'folder:client' })
  ).toThrow('The Codex account assigned to this workspace was removed.')
})
