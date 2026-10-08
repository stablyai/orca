import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import { createPerforceCopyWorkspace } from './perforce-copy-workspace-creation'

const mocks = vi.hoisted(() => ({
  backendFor: vi.fn((connectionId?: string | null) => ({ connectionId })),
  create: vi.fn(async (_input: { backend: unknown; repo: Repo; sourceDir: string }) => ({
    worktreeId: 'p4::/ws.wt/one',
    summary: { stream: '//depot/one' }
  })),
  resolveRoot: vi.fn(async (path: string) => `resolved:${path}`)
}))

vi.mock('../../../perforce/perforce-copy-backend', () => ({
  resolveWorkspaceCopyBackend: mocks.backendFor
}))
vi.mock('../../../perforce/perforce-copy-creation', () => ({
  createPerforceCopyForWorkspace: mocks.create
}))
vi.mock('../../../perforce/perforce-desktop-settings', () => ({
  desktopPerforceSettings: () => ({}),
  runWithDesktopPerforceSettings: (_store: unknown, run: () => unknown) => run()
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  resolveRegisteredWorktreePath: mocks.resolveRoot
}))
vi.mock('../../worktree-remote', () => ({ emitCreateWorktreeProgress: vi.fn() }))
vi.mock('../create/folder-workspace-creation', () => ({ folderWorkspaceCreateMeta: () => ({}) }))
vi.mock('../folder-workspace-model', () => ({
  mergeFolderWorkspace: (_repo: Repo, id: string) => ({ id })
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setWorktreeMeta is the only store method this path calls outside the mocked modules.
const store = { setWorktreeMeta: () => ({}) } as unknown as Store
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window only reaches the mocked progress emitter.
const mainWindow = {} as BrowserWindow

function repo(patch: Partial<Repo>): Repo {
  return { id: 'p4', path: '/ws', displayName: 'ws', badgeColor: '#888888', addedAt: 0, ...patch }
}

beforeEach(() => vi.clearAllMocks())

describe('createPerforceCopyWorkspace', () => {
  it('copies on the SSH host a row names only in executionHostId', async () => {
    await createPerforceCopyWorkspace(
      { repoId: 'p4', name: 'one' },
      repo({ kind: 'folder', executionHostId: 'ssh:box' }),
      store,
      mainWindow
    )
    expect(mocks.backendFor).toHaveBeenCalledWith('box')
    expect(mocks.resolveRoot).not.toHaveBeenCalled()
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      sourceDir: '/ws',
      repo: { connectionId: 'box' }
    })
  })

  it('copies a local project on this computer, from its registered root', async () => {
    await createPerforceCopyWorkspace({ repoId: 'p4', name: 'one' }, repo({}), store, mainWindow)
    expect(mocks.backendFor).toHaveBeenCalledWith(undefined)
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({ sourceDir: 'resolved:/ws' })
  })
})
