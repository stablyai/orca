import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from './persistence'
import { testState, createStore, makeRepo } from './persistence-test-harness'
import {
  applyProjectHostSetupPathRelocation,
  relocateProjectPath,
  type WorktreeRenameNotifier
} from './project-path-relocation'
import { RuntimeProjectHostSetupController } from './runtime/runtime-project-host-setup-controller'
import { registerProjectHostSetupHandlers } from './ipc/repos/project-host-setup-handlers'
import { renameWorktreeFolderOnFirstWork } from './agent-hooks/first-work-folder-rename'
import { computeWorktreePath } from './ipc/worktree-logic'

const ipcHandlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    }
  }
}))

let root = ''
let oldPath = ''
let newPath = ''

/** Every old->new pair the change announced, in order. This is the payload the renderer re-keys on. */
type RenameNotice = { repoId: string; oldWorktreeId: string; newWorktreeId: string }

function recordingNotifier(): { notify: WorktreeRenameNotifier; notices: RenameNotice[] } {
  const notices: RenameNotice[] = []
  return {
    notices,
    notify: (repoId, oldWorktreeId, newWorktreeId) =>
      notices.push({ repoId, oldWorktreeId, newWorktreeId })
  }
}

/** The real Store, so relocation is driven through the same state the app persists. */
function storeWithFolderProject(): Store {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'folder' }))
  return store
}

const rootWorkspaceId = (): string => `r1::${oldPath}`
const INSTANCE_UUID = '11111111-1111-1111-1111-111111111111'
const instanceWorkspaceId = (): string => `r1::${oldPath}::workspace:${INSTANCE_UUID}`

function makeDirs(prefix: string): void {
  testState.dir = mkdtempSync(join(tmpdir(), `orca-${prefix}-`))
  root = mkdtempSync(join(tmpdir(), `orca-projects-${prefix}-`))
  oldPath = join(root, 'example-project')
  newPath = join(root, 'renamed-project')
  mkdirSync(oldPath)
  mkdirSync(newPath)
}

function cleanupDirs(): void {
  ipcHandlers.clear()
  rmSync(testState.dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

describe('relocateProjectPath', () => {
  beforeEach(() => makeDirs('relocate'))
  afterEach(cleanupDirs)

  it('carries a folder project and every workspace identity to the new path', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft', isPinned: true })
    const { notify, notices } = recordingNotifier()

    const result = relocateProjectPath(store, store.getRepo('r1') as never, newPath, notify)

    expect(result.outcome).toBe('relocated')
    expect(store.getRepo('r1')?.path).toBe(newPath)
    const movedInstance = store.getWorktreeMeta(`r1::${newPath}::workspace:${INSTANCE_UUID}`)
    expect(movedInstance?.displayName).toBe('draft')
    expect(movedInstance?.isPinned).toBe(true)
    expect(store.getWorktreeMeta(instanceWorkspaceId())).toBeUndefined()
    // Every re-keyed id must be announced, or the renderer reads it as a deletion.
    expect(new Set(notices.map((notice) => notice.oldWorktreeId))).toEqual(
      new Set([rootWorkspaceId(), instanceWorkspaceId()])
    )
    expect(notices.every((notice) => notice.repoId === 'r1')).toBe(true)
  })

  it('moves worktrees inside the project directory, as a relative worktree base puts them', () => {
    const store = createStore()
    store.addRepo(
      makeRepo({ id: 'r1', path: oldPath, kind: 'git', worktreeBasePath: '.worktrees' })
    )
    const childId = `r1::${join(oldPath, '.worktrees', 'feature')}`
    store.setWorktreeMeta(`r1::${oldPath}`, { displayName: 'main' })
    store.setWorktreeMeta(childId, { displayName: 'feature' })
    const { notify, notices } = recordingNotifier()

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, notify)

    const movedChildId = `r1::${join(newPath, '.worktrees', 'feature')}`
    expect(store.getWorktreeMeta(movedChildId)?.displayName).toBe('feature')
    expect(store.getWorktreeMeta(childId)).toBeUndefined()
    expect(notices.map((notice) => notice.newWorktreeId)).toContain(movedChildId)
  })

  it('leaves a worktree outside the project directory where it is', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'git' }))
    const outsideId = `r1::${join(root, 'elsewhere', 'feature')}`
    store.setWorktreeMeta(outsideId, { displayName: 'feature' })
    const { notify, notices } = recordingNotifier()

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, notify)

    expect(store.getWorktreeMeta(outsideId)?.displayName).toBe('feature')
    expect(notices.map((notice) => notice.oldWorktreeId)).not.toContain(outsideId)
  })

  it('keeps the session bound to the relocated workspace', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    store.setWorkspaceSession({
      tabsByWorktree: {
        [instanceWorkspaceId()]: [
          { id: 'tab-1', worktreeId: instanceWorkspaceId(), type: 'terminal', title: 'zsh' }
        ]
      },
      activeWorktreeId: instanceWorkspaceId()
    } as never)

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, recordingNotifier().notify)

    const session = store.getWorkspaceSession() as unknown as {
      tabsByWorktree?: Record<string, { worktreeId: string }[]>
      activeWorktreeId?: string
    }
    const movedId = `r1::${newPath}::workspace:${INSTANCE_UUID}`
    expect(session.tabsByWorktree?.[movedId]?.[0]?.worktreeId).toBe(movedId)
    expect(session.tabsByWorktree?.[instanceWorkspaceId()]).toBeUndefined()
    expect(session.activeWorktreeId).toBe(movedId)
  })

  it('records the prior id so a session minted under it is not reaped', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, recordingNotifier().notify)

    expect(
      store.getWorktreeMeta(`r1::${newPath}::workspace:${INSTANCE_UUID}`)?.priorWorktreeIds
    ).toContain(instanceWorkspaceId())
  })

  it('leaves a project untouched and announces nothing when the target does not exist', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    const { notify, notices } = recordingNotifier()

    const result = relocateProjectPath(
      store,
      store.getRepo('r1') as never,
      join(root, 'not-there'),
      notify
    )

    expect(result).toMatchObject({ outcome: 'refused' })
    // A refusal must not half-migrate, and must not announce a rename that did not happen.
    expect(store.getRepo('r1')?.path).toBe(oldPath)
    expect(store.getWorktreeMeta(instanceWorkspaceId())?.displayName).toBe('draft')
    expect(notices).toEqual([])
  })

  it('refuses a path another project already occupies', () => {
    const store = storeWithFolderProject()
    store.addRepo(makeRepo({ id: 'r2', path: newPath, displayName: 'Other', kind: 'folder' }))

    const result = relocateProjectPath(
      store,
      store.getRepo('r1') as never,
      newPath,
      recordingNotifier().notify
    )

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(store.getRepo('r1')?.path).toBe(oldPath)
  })

  it('refuses a project whose files live on another execution host', () => {
    const store = createStore()
    store.addRepo(
      makeRepo({ id: 'r1', path: oldPath, kind: 'folder', connectionId: 'ssh-target-1' })
    )

    const result = relocateProjectPath(
      store,
      store.getRepo('r1') as never,
      newPath,
      recordingNotifier().notify
    )

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(store.getRepo('r1')?.path).toBe(oldPath)
  })

  it('reports an unchanged path without rewriting identity or announcing a rename', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    const { notify, notices } = recordingNotifier()

    const result = relocateProjectPath(store, store.getRepo('r1') as never, oldPath, notify)

    expect(result.outcome).toBe('unchanged')
    expect(store.getWorktreeMeta(instanceWorkspaceId())?.displayName).toBe('draft')
    expect(notices).toEqual([])
  })
})

describe('pty identity across a re-key', () => {
  beforeEach(() => makeDirs('pty'))
  afterEach(cleanupDirs)

  function seedTerminal(store: Store, worktreeId: string): string {
    const ptyId = `${worktreeId}@@22222222-2222-2222-2222-222222222222`
    store.setWorktreeMeta(worktreeId, { displayName: 'wt' })
    store.setWorkspaceSession({
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId, type: 'terminal', title: 'zsh', ptyId }]
      }
    } as never)
    return ptyId
  }

  function ptyIdAt(store: Store, worktreeId: string): string | undefined {
    const session = store.getWorkspaceSession() as unknown as {
      tabsByWorktree?: Record<string, { ptyId?: string }[]>
    }
    return session.tabsByWorktree?.[worktreeId]?.[0]?.ptyId
  }

  /**
   * A minted pty id embeds the worktree id that owned it, and neither re-key path rewrites it. This
   * pins that the two paths behave the same, so the orphaned terminal is a property of the shared
   * rename mechanism and not something relocation introduced. Remapping it is its own change.
   */
  it('leaves the pty id spelling the old worktree id on the existing folder-rename path', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'git' }))
    // No directories are created: the move itself is stubbed, only the re-key is under test.
    const worktreePath = computeWorktreePath('wt-old', oldPath, store.getSettings())
    const oldId = `r1::${worktreePath}`
    const ptyId = seedTerminal(store, oldId)
    let newId = ''

    await renameWorktreeFolderOnFirstWork(oldId, 'wt-new', {
      getRepo: (id) => store.getRepo(id),
      getSettings: () => store.getSettings(),
      migrateWorktreeIdentity: (from, to) => store.migrateWorktreeIdentity(from, to),
      notifyWorktreeRenamed: (_repoId, _from, to) => {
        newId = to
      },
      pathExists: async () => false,
      moveWorktree: async () => {}
    })

    expect(newId).not.toBe('')
    expect(ptyIdAt(store, newId)).toBe(ptyId)
  })

  it('leaves the pty id spelling the old worktree id on relocation, identically', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'folder' }))
    const ptyId = seedTerminal(store, `r1::${oldPath}`)

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, recordingNotifier().notify)

    expect(ptyIdAt(store, `r1::${newPath}`)).toBe(ptyId)
  })
})

describe('projectHostSetup.update entry points', () => {
  beforeEach(() => makeDirs('entry'))
  afterEach(cleanupDirs)

  /** The RPC entry point, built the way the runtime builds it. */
  function rpcController(store: Store): {
    controller: RuntimeProjectHostSetupController
    notices: RenameNotice[]
  } {
    const { notify, notices } = recordingNotifier()
    const controller = new RuntimeProjectHostSetupController({
      getStore: () => store as never,
      listRepos: () => store.getRepos(),
      addRepo: vi.fn() as never,
      addRemoteRepo: vi.fn() as never,
      cloneRepo: vi.fn() as never,
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn(),
      notifyWorktreeRenamed: notify
    })
    return { controller, notices }
  }

  it('announces every re-keyed workspace through the RPC entry point', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    const { controller, notices } = rpcController(store)

    controller.updateSetup({ setupId: 'r1', updates: { path: newPath, displayName: 'Renamed' } })

    expect(store.getRepo('r1')?.path).toBe(newPath)
    expect(store.getRepo('r1')?.displayName).toBe('Renamed')
    expect(new Set(notices.map((notice) => notice.oldWorktreeId))).toEqual(
      new Set([rootWorkspaceId(), instanceWorkspaceId()])
    )
    expect(new Set(notices.map((notice) => notice.newWorktreeId))).toEqual(
      new Set([`r1::${newPath}`, `r1::${newPath}::workspace:${INSTANCE_UUID}`])
    )
  })

  it('announces every re-keyed workspace through the IPC entry point', async () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    const notifyWorktreeFolderRenamed = vi.fn()
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    registerProjectHostSetupHandlers(mainWindow as never, store, {
      notifyWorktreeFolderRenamed
    } as never)

    const handler = ipcHandlers.get('projectHostSetups:update')
    expect(handler).toBeDefined()
    await handler?.({}, { setupId: 'r1', updates: { path: newPath } })

    expect(store.getRepo('r1')?.path).toBe(newPath)
    // The desktop surface must deliver the same signal the RPC surface does.
    expect(new Set(notifyWorktreeFolderRenamed.mock.calls.map((call) => call[1]))).toEqual(
      new Set([rootWorkspaceId(), instanceWorkspaceId()])
    )
  })

  it("resolves the repo on the setup's own host, not a sibling row with the same id", () => {
    const store = createStore()
    // The same repo id on two hosts. Persistence documents that an id-only lookup writes one host's
    // row from another's request; a relocation doing that would move the wrong project's files.
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'folder' }))
    store.addRepo(
      makeRepo({ id: 'r1', path: '/srv/example', kind: 'folder', connectionId: 'ssh-target-1' })
    )
    const sshSetup = store
      .getProjectHostSetups()
      .find((setup) => setup.repoId === 'r1' && setup.hostId !== 'local')
    expect(sshSetup).toBeDefined()
    const { notify, notices } = recordingNotifier()

    // Ask on behalf of the SSH setup. Its host owns that filesystem, so this must refuse rather
    // than fall through to the local checkout and relocate it.
    expect(() =>
      applyProjectHostSetupPathRelocation(
        {
          getRepos: () => store.getRepos(),
          relocateRepoPath: (repoId, path, hostId) => store.relocateRepoPath(repoId, path, hostId),
          getProjectHostSetups: () => [sshSetup as never]
        },
        { setupId: sshSetup?.id as string, updates: { path: newPath } },
        notify
      )
    ).toThrow(/another host/)
    expect(store.getRepos().find((repo) => !repo.connectionId)?.path).toBe(oldPath)
    expect(notices).toEqual([])
  })

  it('moves the project host setup row with the repo', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    const { controller } = rpcController(store)

    controller.updateSetup({ setupId: 'r1', updates: { path: newPath } })

    // `setup.path` is projected from the repo catalog and is what an automation resolves its run
    // directory from, so a stale row would run work in the directory the project just left.
    expect(store.getProjectHostSetups().find((setup) => setup.repoId === 'r1')?.path).toBe(newPath)
  })

  it('migrates the session even when the workspace row names its own host', () => {
    const store = storeWithFolderProject()
    // A row carrying a `hostId` must still migrate: naming a disagreeing host at the call site
    // makes the identity migration skip the legacy session state entirely.
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft', hostId: 'ssh:elsewhere' })
    store.setWorkspaceSession({
      tabsByWorktree: {
        [instanceWorkspaceId()]: [
          { id: 'tab-1', worktreeId: instanceWorkspaceId(), type: 'terminal', title: 'zsh' }
        ]
      }
    } as never)

    relocateProjectPath(store, store.getRepo('r1') as never, newPath, recordingNotifier().notify)

    const session = store.getWorkspaceSession() as unknown as {
      tabsByWorktree?: Record<string, { id: string }[]>
    }
    expect(session.tabsByWorktree?.[`r1::${newPath}::workspace:${INSTANCE_UUID}`]).toHaveLength(1)
  })

  it('does not hand persistence a path it did not apply', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    const { controller } = rpcController(store)

    // The stored spelling is the trimmed one, so forwarding the raw request would trip the
    // persistence backstop that refuses any path it did not apply itself.
    controller.updateSetup({
      setupId: 'r1',
      updates: { path: `  ${newPath}  `, displayName: 'Renamed' }
    })

    expect(store.getRepo('r1')?.path).toBe(newPath)
    expect(store.getRepo('r1')?.displayName).toBe('Renamed')
  })

  it('passes an update with no path change straight through', () => {
    const store = storeWithFolderProject()
    const { notify, notices } = recordingNotifier()

    const { updates, relocatedRepo } = applyProjectHostSetupPathRelocation(
      store,
      { setupId: 'r1', updates: { displayName: 'Renamed' } },
      notify
    )

    expect(relocatedRepo).toBeNull()
    expect(updates).toEqual({ displayName: 'Renamed' })
    expect(notices).toEqual([])
  })

  it('surfaces the refusal instead of silently dropping the path', () => {
    const store = storeWithFolderProject()

    expect(() =>
      applyProjectHostSetupPathRelocation(
        store,
        { setupId: 'r1', updates: { path: join(root, 'not-there') } },
        recordingNotifier().notify
      )
    ).toThrow(/No directory exists/)
  })
})
