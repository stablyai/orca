import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const createLocalMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createLocalMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import type { PrepareClaudeAuth } from '../ipc/pty/host-env/types'

const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', kind: 'git' }
const account = {
  id: 'acct-b',
  email: 'pinned@example.com',
  managedAuthRuntime: 'host' as const,
  wslDistro: null,
  authMethod: 'subscription-oauth' as const,
  organizationUuid: null,
  organizationName: null,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

type RuntimeInternals = {
  resolveRepoSelector: (selector: string) => Promise<unknown>
  buildStartupForAgent: (...args: unknown[]) => unknown
  getAccountsSnapshot: () => unknown
}

function makeRuntime(prepareClaudeAuth: PrepareClaudeAuth | undefined): OrcaRuntimeService {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/worktrees' }),
    getProjectHostSetups: () => []
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store), undefined, {
    prepareClaudeAuth
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create only checks that a spawn lane exists; it never spawns here.
  runtime.setPtyController({ spawn: vi.fn() } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named members all exist on the service; the cast only exposes non-public ones to the spies.
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue(repo)
  vi.spyOn(internals, 'buildStartupForAgent').mockReturnValue({
    agent: 'claude',
    startup: { command: 'claude' },
    launchRuntime: new Error('unused')
  })
  vi.spyOn(internals, 'getAccountsSnapshot').mockReturnValue({
    claude: { accounts: [account], activeAccountId: null }
  })
  return runtime
}

describe('worktree create --account preflight', () => {
  it('refuses before creating the checkout when the account cannot be prepared', async () => {
    createLocalMock.mockReset()
    const runtime = makeRuntime(vi.fn().mockRejectedValue(new Error('profile setup failed')))

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'repo-1',
        name: 'app',
        startupAgent: 'claude',
        startupClaudeAccount: 'pinned@example.com'
      })
    ).rejects.toThrow('profile setup failed')
    expect(createLocalMock).not.toHaveBeenCalled()
  })

  it('prepares the pinned account before creating the checkout', async () => {
    createLocalMock.mockReset().mockRejectedValue(new Error('stop after preflight'))
    const prepare = vi.fn<PrepareClaudeAuth>().mockResolvedValue({
      configDir: '/profiles/acct-b/home',
      envPatch: {},
      provenance: 'profile:acct-b:pinned'
    })
    const runtime = makeRuntime(prepare)

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'repo-1',
        name: 'app',
        startupAgent: 'claude',
        startupClaudeAccount: 'pinned@example.com'
      })
    ).rejects.toThrow('stop after preflight')
    expect(prepare).toHaveBeenCalledWith({ runtime: 'host' }, { accountId: 'acct-b' })
    expect(createLocalMock).toHaveBeenCalledOnce()
  })

  it('leaves the decision to the spawn when the runtime has no Claude preparer', async () => {
    createLocalMock.mockReset().mockRejectedValue(new Error('stop after preflight'))
    const runtime = makeRuntime(undefined)

    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'repo-1',
        name: 'app',
        startupAgent: 'claude',
        startupClaudeAccount: 'pinned@example.com'
      })
    ).rejects.toThrow('stop after preflight')
    expect(createLocalMock).toHaveBeenCalledOnce()
  })
})
