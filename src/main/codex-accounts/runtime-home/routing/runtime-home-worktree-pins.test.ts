import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { writeFileSync } from 'node:fs'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService worktree pins (#9496)', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('launches a pinned worktree in its account home whatever the selection', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    const account = (n: number) => ({
      id: `account-${n}`,
      email: `${n}@example.com`,
      managedHomePath: createManagedAuth(
        testState.userDataDir,
        `account-${n}`,
        createCodexAuthJson(`${n}@example.com`, `acct-${n}`, `token-${n}`)
      ),
      providerAccountId: `acct-${n}`,
      workspaceLabel: null,
      workspaceAccountId: `acct-${n}`,
      createdAt: n,
      updatedAt: n,
      lastAuthenticatedAt: n
    })
    const [one, two] = [account(1), account(2)]
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [one, two],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} },
      codexAccountPinsByWorktree: { 'repo::wt-1': 'account-2' }
    })
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
    const service = new CodexRuntimeHomeService(createStore(settings) as never)

    const pinned = { worktreeId: 'repo::wt-1' }
    expect(service.prepareForCodexLaunch(undefined, undefined, pinned)).toBe(two.managedHomePath)
    expect(service.resolveHostCodexHomePathForLaunchReadOnly(undefined, 'repo::wt-1')).toBe(
      two.managedHomePath
    )
    // The pinned launch leaves the selection's own routing as it was.
    expect(service.prepareForCodexLaunch(undefined, undefined, { worktreeId: 'repo::wt-2' })).toBe(
      one.managedHomePath
    )
    expect(settings.activeCodexManagedAccountIdsByRuntime.host).toBe('account-1')
  })
})
