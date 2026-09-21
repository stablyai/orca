// createManagedWorktree used to pick remote-vs-local from the raw `connectionId` field, so a repo
// stamped only `executionHostId: 'ssh:*'` ran `git worktree add` on the client against a remote
// path — and the folder branch, which returns before that check, wrote agent trust locally for a
// remote workspace. Both are the #11163 shape: read the execution host, never one spelling of it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const createRuntimeFolderWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-folder-worktree-create', () => ({
  createRuntimeFolderWorktree: createRuntimeFolderWorktreeMock
}))

const createRuntimeLocalManagedWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createRuntimeLocalManagedWorktreeMock
}))

const trustMocks = vi.hoisted(() => ({
  local: vi.fn(async () => {}),
  remote: vi.fn(async () => {})
}))
vi.mock('./runtime-worktree-agent-startup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markLocalWorktreeTrusted: trustMocks.local,
  markRemoteWorktreeTrusted: trustMocks.remote
}))

import { OrcaRuntimeService } from './orca-runtime'

const TARGET_ID = 'remote-1'
const REMOTE_PATH = '/srv/app'

type RuntimeInternals = {
  resolveRepoSelector: (selector: string) => Promise<unknown>
  createManagedRemoteWorktree: (repo: unknown, args: unknown) => Promise<unknown>
  resolveLineageForWorktreeCreate: (input: unknown) => Promise<unknown>
  recordCreatedWorktreeLineage: (worktree: unknown, resolution: unknown) => unknown
}

function makeRuntime(repo: Record<string, unknown>): {
  runtime: OrcaRuntimeService
  createRemote: ReturnType<typeof vi.fn>
} {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
    getProjectHostSetups: () => []
  }
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue(repo)
  vi.spyOn(internals, 'resolveLineageForWorktreeCreate').mockResolvedValue(null)
  vi.spyOn(internals, 'recordCreatedWorktreeLineage').mockReturnValue({
    lineage: null,
    workspaceLineage: null,
    warnings: []
  })
  const createRemote = vi.fn().mockResolvedValue({
    worktree: { id: 'wt-1', path: '/srv/app-feature', branch: 'feature' }
  })
  vi.spyOn(internals, 'createManagedRemoteWorktree').mockImplementation(createRemote)
  return { runtime, createRemote }
}

describe('createManagedWorktree execution-host routing', () => {
  beforeEach(() => {
    createRuntimeFolderWorktreeMock.mockReset()
    createRuntimeFolderWorktreeMock.mockResolvedValue({ worktree: { id: 'folder-1' } })
    createRuntimeLocalManagedWorktreeMock.mockReset()
    // Name the defect in the failure output: reaching this mock means a remote repo was routed
    // into a client-side `git worktree add`.
    createRuntimeLocalManagedWorktreeMock.mockRejectedValue(
      new Error('local_worktree_create_ran_for_remote_repo')
    )
    trustMocks.local.mockClear()
    trustMocks.remote.mockClear()
  })

  it('creates on the SSH host for a repo stamped executionHostId only', async () => {
    const { runtime, createRemote } = makeRuntime({
      id: 'repo-remote',
      path: REMOTE_PATH,
      kind: 'git',
      executionHostId: `ssh:${TARGET_ID}`
    })

    await runtime.createManagedWorktree({ repoSelector: 'repo-remote', name: 'feature' } as never)

    // A local `git worktree add` against a remote path is the silent-substitution failure.
    expect(createRuntimeLocalManagedWorktreeMock).not.toHaveBeenCalled()
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-remote', connectionId: TARGET_ID }),
      expect.anything()
    )
  })

  it('still creates on the SSH host for a legacy connectionId-only repo', async () => {
    const { runtime, createRemote } = makeRuntime({
      id: 'repo-remote',
      path: REMOTE_PATH,
      kind: 'git',
      connectionId: TARGET_ID
    })

    await runtime.createManagedWorktree({ repoSelector: 'repo-remote', name: 'feature' } as never)

    expect(createRuntimeLocalManagedWorktreeMock).not.toHaveBeenCalled()
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: TARGET_ID }),
      expect.anything()
    )
  })

  it('marks a folder workspace trusted on its SSH host, not on the client', async () => {
    const { runtime } = makeRuntime({
      id: 'repo-folder',
      path: REMOTE_PATH,
      kind: 'folder',
      connectionId: TARGET_ID,
      executionHostId: `ssh:${TARGET_ID}`
    })

    await runtime.createManagedWorktree({ repoSelector: 'repo-folder', name: 'notes' } as never)

    const deps = createRuntimeFolderWorktreeMock.mock.calls[0]?.[0]?.deps
    await deps.markTrusted('codex', '/srv/app')

    expect(trustMocks.remote).toHaveBeenCalledWith('codex', TARGET_ID, '/srv/app')
    expect(trustMocks.local).not.toHaveBeenCalled()
  })

  it('keeps a local folder workspace trusted on the client', async () => {
    const { runtime } = makeRuntime({
      id: 'repo-folder-local',
      path: '/Users/me/notes',
      kind: 'folder'
    })

    await runtime.createManagedWorktree({
      repoSelector: 'repo-folder-local',
      name: 'notes'
    } as never)

    const deps = createRuntimeFolderWorktreeMock.mock.calls[0]?.[0]?.deps
    await deps.markTrusted('codex', '/Users/me/notes')

    expect(trustMocks.local).toHaveBeenCalledWith('codex', '/Users/me/notes')
    expect(trustMocks.remote).not.toHaveBeenCalled()
  })
})
