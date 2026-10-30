// Pin execution-host resolution end to end (#11163): repo-only lookup ignored worktree.hostId and conflated runtime, unresolved and local as undefined.
// Refuse ssh: hosts explicitly; companion to runtime-git-target-execution-host.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

import type * as MarkdownDocumentsModule from '../ipc/markdown-documents'

const mocks = vi.hoisted(() => ({ listMarkdownDocuments: vi.fn() }))

vi.mock('../ipc/markdown-documents', async () => ({
  ...(await vi.importActual<typeof MarkdownDocumentsModule>('../ipc/markdown-documents')),
  listMarkdownDocuments: mocks.listMarkdownDocuments
}))

import { ExecutionHostNotDispatchableError } from '../providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { OrcaRuntimeService } from './orca-runtime'

const REMOTE_PATH = '/srv/app-feature'
const WORKTREE_ID = 'repo-shared::/srv/app-feature'

function makeRuntime(repos: readonly Record<string, unknown>[], hostId?: string) {
  const store = {
    getSettings: () => ({
      disabledTuiAgents: [],
      workspaceDir: '/tmp/workspaces'
    }),
    getProjectHostSetups: () => [],
    getProjects: () => [],
    getFolderWorkspaces: () => [],
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id)
  }
  const runtime = new OrcaRuntimeService(store as never)
  runtime['resolveGitWorktreeSelector'] = vi.fn().mockResolvedValue({
    id: WORKTREE_ID,
    repoId: 'repo-shared',
    path: REMOTE_PATH,
    git: {
      path: REMOTE_PATH,
      branch: 'main',
      isBare: false,
      isMainWorktree: false
    },
    ...(hostId ? { hostId } : {})
  })
  return runtime
}

async function expectRefusedFor(promise: Promise<unknown>, connectionId: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(SshHostNotServedError)
  expect(error).toMatchObject({ connectionId })
  expect(mocks.listMarkdownDocuments).not.toHaveBeenCalled()
}

describe('runtime file target execution host', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.listMarkdownDocuments.mockReset().mockResolvedValue([])
  })

  // Choose a rival SSH row first to expose repo-id-only cross-host resolution.
  it('routes an ssh workspace to the host it names, not to a rival row on another ssh host', async () => {
    const runtime = makeRuntime(
      [
        { id: 'repo-shared', path: '/home/me/app', connectionId: 'openclaw' },
        { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' }
      ],
      'ssh:m4air'
    )

    await expectRefusedFor(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`), 'm4air')
  })

  it("routes to the workspace's host even when the only repo row names a different ssh host", async () => {
    const runtime = makeRuntime(
      [{ id: 'repo-shared', path: '/home/me/app', connectionId: 'openclaw' }],
      'ssh:m4air'
    )

    await expectRefusedFor(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`), 'm4air')
  })

  // Local rows cannot carry SSH connectionId; the old target incorrectly read local files on that remote host.
  it('ignores a stale connection on a row that declares itself local', async () => {
    const runtime = makeRuntime(
      [
        {
          id: 'repo-shared',
          path: '/home/me/app',
          executionHostId: 'local',
          connectionId: 'm4air'
        }
      ],
      'local'
    )

    await runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`)

    expect(mocks.listMarkdownDocuments).toHaveBeenCalledWith(REMOTE_PATH, {})
  })

  // Runtime connectionId belongs to the server's target namespace, never this client's.
  it('refuses a runtime host whose row carries a nested ssh target', async () => {
    const runtime = makeRuntime(
      [
        {
          id: 'repo-shared',
          path: '/srv/app',
          executionHostId: 'runtime:env-a',
          connectionId: 'nested-1'
        }
      ],
      'runtime:env-a'
    )

    await expect(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`)).rejects.toThrow(
      ExecutionHostNotDispatchableError
    )
    expect(mocks.listMarkdownDocuments).not.toHaveBeenCalled()
  })

  it('refuses a runtime host with no nested ssh target rather than answering locally', async () => {
    const runtime = makeRuntime(
      [
        {
          id: 'repo-shared',
          path: '/srv/app',
          executionHostId: 'runtime:env-a'
        }
      ],
      'runtime:env-a'
    )

    await expect(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`)).rejects.toThrow(
      ExecutionHostNotDispatchableError
    )
    expect(mocks.listMarkdownDocuments).not.toHaveBeenCalled()
  })

  it('refuses rather than guessing when rival rows disagree and the workspace names no host', async () => {
    const runtime = makeRuntime([
      { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' },
      { id: 'repo-shared', path: '/home/me/app' }
    ])

    await expect(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'worktree_execution_host_unresolved'
    )
    expect(mocks.listMarkdownDocuments).not.toHaveBeenCalled()
  })

  it('still routes by the single row when the workspace names no host', async () => {
    const runtime = makeRuntime([{ id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' }])

    await expectRefusedFor(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`), 'm4air')
  })

  // Losing contact with a remote host is never evidence that its files are here
  // (docs/reference/ssh-execution-boundary.md).
  it('reports the dropped connection instead of reading a remote path locally', async () => {
    const runtime = makeRuntime(
      [{ id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' }],
      'ssh:m4air'
    )

    await expect(runtime.listRuntimeMarkdownDocuments(`id:${WORKTREE_ID}`)).rejects.toThrow(
      /Remote connection dropped/
    )
    expect(mocks.listMarkdownDocuments).not.toHaveBeenCalled()
  })

  // Guard against recomputing host from connectionId and accepting expectations the workspace never named.
  it('rejects a mutation whose expected host is the row rather than the resolved one', async () => {
    const runtime = makeRuntime(
      [{ id: 'repo-shared', path: '/home/me/app', connectionId: 'openclaw' }],
      'ssh:m4air'
    )

    await expect(
      runtime.createFileExplorerDir(
        `id:${WORKTREE_ID}`,
        'docs',
        undefined,
        undefined,
        'ssh:openclaw'
      )
    ).rejects.toThrow('Workspace host changed; refresh and try again')
  })
})
