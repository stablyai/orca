import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import { resolveCodexLaunchAccount } from '../codex-accounts/codex-launch-account'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { WORKTREE_METHODS } from './rpc/methods/worktree'

const { createLocal, createFolder } = vi.hoisted(() => ({
  createLocal: vi.fn(),
  createFolder: vi.fn()
}))
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createLocal
}))
vi.mock('./runtime-folder-worktree-create', () => ({ createRuntimeFolderWorktree: createFolder }))
beforeEach(() => {
  createLocal.mockReset()
  createFolder.mockReset()
})

function fixture(repoUpdates: Partial<Repo> = {}) {
  const settings = createSettings()
  const store = { getSettings: () => settings, updateSettings: vi.fn(), getProjects: () => [] }
  const repo: Repo = {
    id: 'repo-1',
    path: '/fixture',
    displayName: 'fixture',
    badgeColor: 'blue',
    addedAt: 1,
    ...repoUpdates
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: account preflight reads only settings/projects; reaching creation or any omitted store method is a test failure.
  const runtime = new OrcaRuntimeService(store as never)
  const spawn = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these refusal tests only check that native spawn exists and never call the controller.
  runtime.setPtyController({ spawn } as never)
  vi.spyOn(runtime, 'resolveCodexLaunchAccount').mockImplementation((selector) =>
    resolveCodexLaunchAccount(
      [
        { id: 'account-a', email: 'same@example.com' },
        { id: 'account-b', email: 'SAME@example.com' }
      ],
      selector
    )
  )
  vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo)
  const showSettings = vi.spyOn(store, 'getSettings')
  const request = {
    repoSelector: 'id:repo-1',
    name: 'pinned',
    startupAgent: 'codex' as const,
    startupAccount: 'account-b'
  }
  return { runtime, request, store, settings, spawn, showSettings }
}

function expectNoCreate(f: ReturnType<typeof fixture>) {
  expect(createLocal).not.toHaveBeenCalled()
  expect(createFolder).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.store.updateSettings).not.toHaveBeenCalled()
}

describe('worktree account refusals precede native/forwarded create', () => {
  it.each(['unknown', 'same@example.com'])(
    'refuses %s before workspace lookup or preparation',
    async (startupAccount) => {
      const f = fixture()
      await expect(
        f.runtime.createManagedWorktree({ ...f.request, startupAccount })
      ).rejects.toThrow()
      expect(f.runtime.showRepo).not.toHaveBeenCalled()
      expect(f.showSettings).not.toHaveBeenCalled()
      expectNoCreate(f)
    }
  )

  it.each(['ssh:target', 'runtime:server'] as const)(
    'refuses %s for git and folder repositories before any create',
    async (executionHostId) => {
      for (const kind of ['git', 'folder'] as const) {
        const f = fixture({ executionHostId, kind })
        await expect(f.runtime.createManagedWorktree(f.request)).rejects.toThrow('native host only')
        expectNoCreate(f)
      }
    }
  )

  it('refuses custom launch commands before a worktree is created', async () => {
    const f = fixture()
    f.settings.agentCmdOverrides = { codex: 'custom-wrapper' }
    await expect(f.runtime.createManagedWorktree(f.request)).rejects.toThrow(
      'custom Codex launch command'
    )
    expectNoCreate(f)
  })

  it('refuses prebuilt startup commands and an unavailable native PTY before lookup', async () => {
    const f = fixture()
    await expect(
      f.runtime.createManagedWorktree({ ...f.request, startup: { command: 'codex' } })
    ).rejects.toThrow('fresh native startup agent')
    f.runtime.setPtyController(null)
    await expect(f.runtime.createManagedWorktree(f.request)).rejects.toThrow(
      'fresh native startup agent'
    )
    expect(f.runtime.showRepo).not.toHaveBeenCalled()
    expectNoCreate(f)
  })

  it('refuses pins before a warm legacy cache while preserving unpinned replay', async () => {
    const f = fixture()
    const request = {
      repo: 'id:repo-1',
      name: 'pinned',
      startupAgent: 'codex',
      clientMutationId: 'same-create'
    }
    const previous = { worktree: { id: 'previous-unpinned' } }
    await f.runtime.dedupeWorktreeCreate(
      request.repo,
      request.clientMutationId,
      async () => previous
    )
    const dedupe = vi.spyOn(f.runtime, 'dedupeWorktreeCreate')
    const dispatcher = new RpcDispatcher({ runtime: f.runtime, methods: WORKTREE_METHODS })
    const replay = await dispatcher.dispatch({
      id: 'legacy-replay',
      authToken: 'test-token',
      method: 'worktree.create',
      params: request
    })
    expect(replay).toMatchObject({ ok: true, result: previous })
    dedupe.mockClear()
    const pin = await dispatcher.dispatch({
      id: 'pin-b',
      authToken: 'test-token',
      method: 'worktree.create',
      params: { ...request, startupAccount: 'account-b' }
    })
    expect(pin).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('operationId') }
    })
    expect(dedupe).not.toHaveBeenCalled()
    expect(f.runtime.showRepo).not.toHaveBeenCalled()
    expectNoCreate(f)
  })
})
