import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceCopyListResult } from '../../shared/perforce/workspace-copy/workspace-copy-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { currentPerforceSettings } from '../../shared/perforce/p4-settings-context'
import {
  RuntimePerforceCopyCommands,
  createRuntimePerforceCopy,
  type RuntimePerforceCopyCommandHost
} from './runtime-perforce-copy-commands'

const events: string[] = []
let detectedWorkspace = true

const LISTING: WorkspaceCopyListResult = {
  source: { client: 'ws_me', root: 'D:\\ws', stream: '//g/dev' },
  copiesDir: 'D:\\ws.wt',
  serverChecked: true,
  copies: [
    {
      name: 'copy-1',
      client: 'ws_me_wt_copy-1',
      copyRoot: 'D:\\ws.wt\\copy-1',
      stream: '//g/dev_wt_copy-1',
      mode: 'child',
      folderExists: true,
      clientExists: true,
      markerExists: true,
      created: '2026-10-01T08:54:41.000Z',
      createdBy: null
    }
  ]
}

const PREVIEW = {
  name: 'copy-1',
  client: 'ws_me_wt_copy-1',
  copyRoot: 'D:\\ws.wt\\copy-1',
  markerPath: 'D:\\ws.wt\\copy-1.p4-worktree.json',
  clientExists: true,
  folderExists: true,
  stream: '//g/dev_wt_copy-1',
  openFiles: { count: 2, sample: ['a.cs', 'b.cs'] },
  pendingChanges: [],
  childStream: null,
  processesHoldingFolder: [],
  holders: [],
  blockers: { openFiles: true, shelves: false }
}

const backend = {
  readiness: vi.fn(async (_cwd: string, minFreeBytes?: number) => ({ ready: true, minFreeBytes })),
  list: vi.fn(async () => LISTING),
  create: vi.fn(),
  previewRemoval: vi.fn(async () => PREVIEW),
  remove: vi.fn(async () => {
    events.push('remove')
    return { name: 'copy-1' }
  }),
  streams: vi.fn()
}

vi.mock('../perforce/perforce-copy-backend', () => ({
  resolveWorkspaceCopyBackend: (connectionId?: string | null) => {
    events.push(`backend:${connectionId ?? 'local'}`)
    return backend
  }
}))
vi.mock('../perforce/perforce-ssh-backend', () => ({
  resolvePerforceBackend: () => ({
    detect: async () => ({ isWorkspace: detectedWorkspace, reason: 'not-in-workspace' })
  })
}))
vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: () => events.push('invalidate-roots')
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: 'D:\\ws',
    displayName: 'ws',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'folder',
    ...overrides
  }
}

function makeCommands(repo: Repo, meta: Record<string, Partial<WorktreeMeta>> = {}) {
  const store = {
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: (id: string, patch: Partial<WorktreeMeta>) => {
      meta[id] = { ...meta[id], ...patch }
      return meta[id]
    },
    updateRepo: vi.fn((_id: string, _updates: Partial<Repo>, hostId?: string) => {
      events.push(`update-repo:${hostId}`)
      return null
    })
  }
  const host = {
    resolveRepo: vi.fn(async () => repo),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commands read and write worktree meta and updateRepo only.
    getStore: () => store as unknown as ReturnType<RuntimePerforceCopyCommandHost['getStore']>,
    getRuntimeSettings: () => ({}),
    acquireFileWatcherRemoval: vi.fn(async () => {
      events.push('gate')
      return { finish: async (completed: boolean) => void events.push(`gate-done:${completed}`) }
    }),
    stopWorkspaceTerminals: vi.fn(async () => void events.push('stop-terminals')),
    forgetWorktree: vi.fn(
      (worktreeId: string, _repoId: string) => void events.push(`forget:${worktreeId}`)
    ),
    worktreesChanged: vi.fn(() => void events.push('worktrees-changed')),
    reposChanged: vi.fn(() => void events.push('repos-changed'))
  }
  return { commands: new RuntimePerforceCopyCommands(host), host, store, meta }
}

beforeEach(() => {
  events.length = 0
  detectedWorkspace = true
  vi.clearAllMocks()
})

describe('RuntimePerforceCopyCommands', () => {
  it('only acts on folder projects', async () => {
    const { commands } = makeCommands(makeRepo({ kind: 'git' }))
    await expect(commands.runPerforceCopyOperation('id:repo-1', 'syncCopies', {})).rejects.toThrow(
      'folder project'
    )
  })

  it('marks a folder project inside a workspace as a Perforce project on its own host', async () => {
    const { commands } = makeCommands(makeRepo({ executionHostId: 'ssh:build-box' }))
    await expect(commands.runPerforceCopyOperation('id:repo-1', 'detectProject', {})).resolves.toBe(
      true
    )
    expect(events).toEqual(['backend:build-box', 'update-repo:ssh:build-box', 'repos-changed'])
  })

  it('never unmarks a Perforce project when p4 does not answer', async () => {
    detectedWorkspace = false
    const { commands, store } = makeCommands(makeRepo({ vcs: 'perforce' }))
    await expect(commands.runPerforceCopyOperation('id:repo-1', 'detectProject', {})).resolves.toBe(
      true
    )
    expect(store.updateRepo).not.toHaveBeenCalled()
  })

  it("checks readiness against the client's minimum free space", async () => {
    const { commands } = makeCommands(makeRepo())
    await commands.runPerforceCopyOperation('id:repo-1', 'copyReadiness', {
      settings: { copyMinFreeSpaceGb: 3 }
    })
    expect(backend.readiness).toHaveBeenCalledWith('D:\\ws', 3 * 1024 ** 3)
  })

  it('adopts copies made outside Orca and tells clients', async () => {
    const { commands, meta } = makeCommands(makeRepo())
    await commands.runPerforceCopyOperation('id:repo-1', 'syncCopies', {})
    expect(Object.keys(meta)).toEqual(['repo-1::D:\\ws.wt\\copy-1'])
    expect(events).toEqual(['backend:local', 'invalidate-roots', 'worktrees-changed'])
  })

  it('refuses before closing anything when the copy has open files and no opt-in', async () => {
    const { commands, host } = makeCommands(makeRepo(), {
      'repo-1::D:\\ws.wt\\copy-1': { displayName: 'copy-1' }
    })
    await expect(
      commands.runPerforceCopyOperation('id:repo-1', 'removeCopy', { name: 'copy-1' })
    ).rejects.toThrow('2 file(s) are open')
    expect(host.stopWorkspaceTerminals).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
  })

  it('stops the copy’s terminals inside the watcher gate, then deletes and forgets it', async () => {
    const { commands } = makeCommands(makeRepo(), {
      'repo-1::D:\\ws.wt\\copy-1': { displayName: 'copy-1' }
    })
    await commands.runPerforceCopyOperation('id:repo-1', 'removeCopy', {
      name: 'copy-1',
      revertOpenFiles: true
    })
    expect(events).toEqual([
      'backend:local',
      'gate',
      'stop-terminals',
      'remove',
      'gate-done:true',
      'forget:repo-1::D:\\ws.wt\\copy-1',
      'worktrees-changed'
    ])
  })

  it('names a project that is gone instead of answering with a selector code', async () => {
    const { commands, host } = makeCommands(makeRepo())
    host.resolveRepo.mockRejectedValueOnce(new Error('repo_not_found'))
    await expect(commands.runPerforceCopyOperation('id:repo-1', 'syncCopies', {})).rejects.toThrow(
      'no longer in Orca on this host'
    )
  })

  it('makes the copy behind a new workspace with the client’s copy options', async () => {
    backend.create.mockImplementation(async () => {
      events.push(`create:${currentPerforceSettings().copyMinFreeSpaceGb}`)
      return {
        name: 'feature-x',
        copyRoot: 'D:\\ws.wt\\feature-x',
        source: { client: 'ws_me', root: 'D:\\ws', stream: '//g/dev' },
        stream: '//g/dev_wt_feature-x',
        streamChoice: 'child',
        space: { copiedBytes: 0, usedBytes: 0, cloned: true, freeBytesAfter: 0 },
        warnings: [],
        unityVersionControlBinding: null
      }
    })
    const creation = await createRuntimePerforceCopy(
      makeRepo(),
      { workspaceName: 'Feature X', settings: { copyMinFreeSpaceGb: 7 } },
      {}
    )
    expect(creation.worktreeId).toBe('repo-1::D:\\ws.wt\\feature-x')
    expect(backend.create).toHaveBeenCalledWith(
      'D:\\ws',
      expect.objectContaining({ minFreeBytes: 7 * 1024 ** 3 }),
      expect.any(Function)
    )
    expect(events).toEqual(['backend:local', 'create:7'])
  })
})
