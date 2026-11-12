import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeProjectGroupDependencies } from './runtime-project-group-contract'
import { killAllProcessesForWorktrees } from '../workspaces/removal/worktree-batch-teardown'
import { captureWorktreeTerminalStops } from '../terminal/stop/worktree-terminal-removal-snapshot'
import type { WorktreeTeardownRuntime } from '../workspaces/removal/worktree-teardown'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { PtyProcessInfo } from '../../providers/pty-process-info'
import type { RuntimePtyWorktreeRecord } from '../terminal/records/runtime-terminal-state-records'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import * as registry from '../../memory/pty-registry'
import * as folderArchive from '../../workspaces/removal/folder-workspace-archive-hook'
import { worktreeRemovalTargetKey } from '../workspaces/removal/worktree-removal-targets'

vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => null
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-group-removal-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture(archive: string) {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Services',
    parentPath: testState.dir,
    createdFrom: 'folder-scan'
  })
  store.updateProjectGroup(group.id, {
    hookSettings: {
      mode: 'auto',
      commandSourcePolicy: 'local-only',
      scripts: { setup: '', archive }
    }
  })
  const first = store.createFolderWorkspace({ projectGroupId: group.id, name: 'First' })
  const second = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Second' })
  const deps: RuntimeProjectGroupDependencies = {
    getStore: () => store,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged: vi.fn(),
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: vi.fn(async () => false),
    teardownFolderWorkspacesPtys: vi.fn<
      NonNullable<RuntimeProjectGroupDependencies['teardownFolderWorkspacesPtys']>
    >(
      async (targets) => new Map(targets.map((target) => [worktreeRemovalTargetKey(target), false]))
    ),
    acquireFileWatcherRemoval: vi.fn(async () => ({ finish: vi.fn(async () => {}) })),
    cleanupRemovedFolderWorkspaceState: vi.fn(),
    emitWorktreeLifecycle: vi.fn()
  }
  return { controller: new RuntimeProjectGroupController(deps), store, group, first, second, deps }
}

describe('group folder archive before forgetting', () => {
  it('keeps unproven runners while retiring proven siblings and forgetting the group', async () => {
    const { controller, store, group, first, second, deps } = fixture('')
    const removeRunner = vi
      .spyOn(folderArchive, 'removeFolderWorkspaceRunnerFiles')
      .mockImplementation(() => {})
    vi.mocked(deps.teardownFolderWorkspacesPtys!).mockImplementation(
      async (targets) =>
        new Map(
          targets.map((target) => [
            worktreeRemovalTargetKey(target),
            target.worktreeId === folderWorkspaceKey(second.id)
          ])
        )
    )
    expect(await controller.deleteGroup(group.id)).toEqual({ deleted: true })
    expect(store.getFolderWorkspaces()).toEqual([])
    expect(store.getProjectGroups()).toEqual([])
    expect(removeRunner.mock.calls.map(([, id]) => id)).toEqual([folderWorkspaceKey(second.id)])
    expect(removeRunner).not.toHaveBeenCalledWith(expect.anything(), folderWorkspaceKey(first.id))
  })

  it('keeps group deletion bulk as workspace count and distinct watcher roots grow', async () => {
    const measure = async (count: number, roots: number, unrelated = 100) => {
      const { controller, store, group, deps } = fixture('')
      const existing = store.getFolderWorkspaces().length
      for (let i = existing; i < count; i++) {
        store.createFolderWorkspace({
          projectGroupId: group.id,
          name: `Task ${i}`,
          folderPath: join(testState.dir, `root-${i % roots}`)
        })
      }
      // All rows use the same owner; only distinct cwd roots require watcher leases.
      for (const [i, row] of store.getFolderWorkspaces().entries()) {
        store.updateFolderWorkspace(row.id, {
          folderPath: join(testState.dir, `root-${i % roots}`)
        })
      }
      const rows: PtyProcessInfo[] = [
        ...store.getFolderWorkspaces().map((row) => ({
          id: `${folderWorkspaceKey(row.id)}@@pty`,
          worktreeId: folderWorkspaceKey(row.id),
          title: 'shell',
          cwd: row.folderPath,
          incarnationId: `inc-${row.id}`
        })),
        ...Array.from({ length: unrelated }, (_, i) => ({
          id: `unrelated-${i}@@pty`,
          worktreeId: `unrelated-${i}`,
          title: 'shell',
          cwd: '/scratch',
          incarnationId: `other-${i}`
        }))
      ]
      const visits = { graph: 0, provider: 0, registry: 0, stops: 0, exits: 0, baseLineage: 0 }
      const records = new Map(
        rows.map((row) => [
          row.id,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads these identity and connection fields only.
          {
            ptyId: row.id,
            worktreeId: row.worktreeId!,
            connectionId: null,
            connected: true,
            incarnationId: row.incarnationId
          } as RuntimePtyWorktreeRecord
        ])
      )
      const originalValues = records.values.bind(records)
      records.values = () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this iterator preserves the captured Map rows and only counts visits.
        (function* () {
          for (const row of originalValues()) {
            visits.graph++
            yield row
          }
        })() as MapIterator<RuntimePtyWorktreeRecord>
      const listRegistry = vi.spyOn(registry, 'listRegisteredPtys').mockImplementation(() => {
        visits.registry++
        return []
      })
      const remaining = new Map(rows.map((row) => [row.id, row]))
      const listProcesses = vi.fn(async (options?: { ptyIds?: string[] }) => {
        const result = options?.ptyIds
          ? options.ptyIds.flatMap((id) => (remaining.has(id) ? [remaining.get(id)!] : []))
          : [...remaining.values()]
        visits.provider += result.length
        return result
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: process boundaries are controlled; discovery and cascade/store mutation remain production code.
      const provider = {
        listProcesses,
        shutdown: async (id: string) => {
          visits.stops++
          remaining.delete(id)
        }
      } as unknown as IPtyProvider
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime ports reached by this provider-only scenario.
      const runtime = {
        captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
        currentLocalStructuredSessionPresentation: () => null,
        removeCapturedStructuredSessionSavedTabs: () => {},
        retireStructuredAgentSessionTabFromSnapshot: () => true,
        captureWorktreeTerminalStops: (targets) =>
          captureWorktreeTerminalStops(targets, {
            acquire: async () => () => {},
            captureFence: () => () => {},
            leaves: () => [],
            ptys: records
          }),
        stopTerminalsForWorktree: async () => ({ stopped: 0 }),
        getPtyLivenessVerdict: () => null,
        onPtyExit: () => {
          visits.exits++
        }
      } as WorktreeTeardownRuntime
      vi.mocked(deps.teardownFolderWorkspacesPtys!).mockImplementation((targets) =>
        killAllProcessesForWorktrees(targets, { runtime, localProvider: provider })
      )
      // Baseline lineage still walks L rows per removed folder; report it separately from added work.
      let deleting = false
      const lineage = store.getAllWorkspaceLineage()
      for (let i = 0; i < unrelated; i++) {
        const child = folderWorkspaceKey(`unrelated-${i}`)
        Object.defineProperty(lineage, child, {
          configurable: true,
          enumerable: true,
          value: {
            childWorkspaceKey: child,
            get parentWorkspaceKey() {
              if (deleting) {
                visits.baseLineage++
              }
              return folderWorkspaceKey('unrelated-parent')
            },
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 0
          }
        })
      }
      const originalDelete = store.deleteProjectGroup.bind(store)
      const deleteGroup = vi.spyOn(store, 'deleteProjectGroup').mockImplementation((id) => {
        deleting = true
        try {
          return originalDelete(id)
        } finally {
          deleting = false
        }
      })
      expect(await controller.deleteGroup(group.id)).toEqual({ deleted: true })
      expect(store.getFolderWorkspaces()).toEqual([])
      expect(deps.teardownFolderWorkspacesPtys).toHaveBeenCalledOnce()
      expect(vi.mocked(deps.teardownFolderWorkspacesPtys!).mock.calls[0][0]).toHaveLength(count)
      expect(deps.acquireFileWatcherRemoval).toHaveBeenCalledTimes(roots)
      expect(deleteGroup).toHaveBeenCalledOnce()
      expect(deps.notifyReposChanged).toHaveBeenCalledOnce()
      expect(deps.emitWorktreeLifecycle).toHaveBeenCalledTimes(count)
      expect(listProcesses).toHaveBeenCalledTimes(2)
      expect(visits).toEqual({
        graph: count + unrelated,
        provider: count + unrelated,
        registry: 1,
        stops: count,
        exits: count,
        baseLineage: count * unrelated
      })
      expect(remaining.size).toBe(unrelated)
      listRegistry.mockRestore()
      deleteGroup.mockRestore()
    }
    // One group mutation/publication is required; N results and K root leases are unavoidable output.
    await measure(10, 1)
    await measure(100, 1)
    await measure(100, 100)
    await measure(10, 1, 1000)
  })

  it.skipIf(process.platform === 'win32')(
    'applies mixed owner decisions before the fresh teardown snapshot',
    async () => {
      const { controller, store, group, deps } = fixture('')
      const child = store.createProjectGroup({
        name: 'Child',
        parentPath: testState.dir,
        parentGroupId: group.id,
        createdFrom: 'folder-scan'
      })
      store.createFolderWorkspace({ projectGroupId: child.id, name: 'Skipped child' })
      for (const owner of [group, child]) {
        store.updateProjectGroup(owner.id, {
          hookSettings: {
            mode: 'auto',
            commandSourcePolicy: 'local-only',
            scripts: { setup: '', archive: 'echo "$ORCA_WORKSPACE_NAME" >> archive.txt' }
          }
        })
      }
      vi.mocked(deps.teardownFolderWorkspacesPtys!).mockImplementation(async (targets) => {
        expect(readFileSync(join(testState.dir, 'archive.txt'), 'utf8')).toBe('First\nSecond\n')
        expect(targets).toHaveLength(3)
        return new Map(targets.map((target) => [worktreeRemovalTargetKey(target), false]))
      })
      expect(
        await controller.deleteGroup(group.id, {
          archiveDecisions: { [group.id]: { decision: 'run' }, [child.id]: { decision: 'skip' } }
        })
      ).toEqual({ deleted: true })
      expect(store.getFolderWorkspaces()).toEqual([])
      expect(deps.notifyReposChanged).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'discovers an earlier folder process created by a later archive before forgetting either',
    async () => {
      const { controller, store, group, first, deps } = fixture(
        'echo "$ORCA_WORKSPACE_NAME" >> archive.txt; if [ "$ORCA_WORKSPACE_NAME" = Second ]; then touch late-process; fi'
      )
      const id = `${folderWorkspaceKey(first.id)}@@late`
      let stopped = false
      vi.spyOn(registry, 'listRegisteredPtys').mockReturnValue([])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only provider discovery and shutdown are external to the production cascade here.
      const provider = {
        listProcesses: async () => {
          expect(readFileSync(join(testState.dir, 'archive.txt'), 'utf8')).toBe('First\nSecond\n')
          return existsSync(join(testState.dir, 'late-process')) && !stopped
            ? [
                {
                  id,
                  worktreeId: folderWorkspaceKey(first.id),
                  incarnationId: 'late-inc',
                  title: 'shell',
                  cwd: testState.dir
                }
              ]
            : []
        },
        shutdown: async (ptyId: string) => {
          expect(ptyId).toBe(id)
          stopped = true
        }
      } as unknown as IPtyProvider
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this headless fixture has authoritative empty graph discovery and provider-owned processes.
      const runtime = {
        captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
        currentLocalStructuredSessionPresentation: () => null,
        removeCapturedStructuredSessionSavedTabs: () => {},
        retireStructuredAgentSessionTabFromSnapshot: () => true,
        captureWorktreeTerminalStops: (targets) =>
          captureWorktreeTerminalStops(targets, {
            acquire: async () => () => {},
            captureFence: () => () => {},
            leaves: () => [],
            ptys: new Map()
          }),
        stopTerminalsForWorktree: async () => ({ stopped: 0 }),
        getPtyLivenessVerdict: () => null,
        onPtyExit: () => {}
      } as WorktreeTeardownRuntime
      vi.mocked(deps.teardownFolderWorkspacesPtys!).mockImplementation((targets) =>
        killAllProcessesForWorktrees(targets, { runtime, localProvider: provider })
      )
      expect(await controller.deleteGroup(group.id)).toEqual({ deleted: true })
      expect(stopped).toBe(true)
      expect(store.getFolderWorkspaces()).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains the folder after archive failure and honors an explicit retry',
    async () => {
      const { controller, store, first, deps } = fixture('echo attempted >> archive.txt; exit 7')
      await expect(controller.deleteFolderWorkspace(first.id, { runHooks: true })).rejects.toThrow()
      expect(readFileSync(join(testState.dir, 'archive.txt'), 'utf8')).toBe('attempted\n')
      expect(store.getFolderWorkspace(first.id)).toBeDefined()
      expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
      expect(
        await controller.deleteFolderWorkspace(first.id, {
          runHooks: true,
          allowFailedArchiveHook: true
        })
      ).toEqual({ deleted: true })
      expect(store.getFolderWorkspace(first.id)).toBeUndefined()
      expect(readFileSync(join(testState.dir, 'archive.txt'), 'utf8')).toBe(
        'attempted\nattempted\n'
      )
      expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'continues failing archives, tears down once after them, then publishes one bulk deletion',
    async () => {
      const { controller, store, group, first, second, deps } = fixture(
        'echo "$ORCA_WORKSPACE_NAME" >> archive.txt; exit 7'
      )
      vi.mocked(deps.teardownFolderWorkspacesPtys!).mockImplementation(async (targets) => {
        expect(readFileSync(join(testState.dir, 'archive.txt'), 'utf8')).toBe('First\nSecond\n')
        expect(store.getFolderWorkspaces().map((row) => row.id)).toEqual([first.id, second.id])
        return new Map(targets.map((target) => [worktreeRemovalTargetKey(target), false]))
      })
      expect(await controller.deleteGroup(group.id)).toEqual({ deleted: true })
      expect(store.getFolderWorkspaces()).toEqual([])
      expect(deps.teardownFolderWorkspacesPtys).toHaveBeenCalledOnce()
      expect(deps.acquireFileWatcherRemoval).toHaveBeenCalledOnce()
      expect(deps.notifyReposChanged).toHaveBeenCalledOnce()
      expect(existsSync(testState.dir)).toBe(true)
    }
  )

  it
    .skipIf(process.platform === 'win32')
    .each([
      undefined,
      { decision: 'skip' as const },
      { decision: 'run' as const, approvedContentHash: 'stale' }
    ])('never runs unseen, skipped or changed shared archive bytes (%j)', async (decision) => {
    const { controller, store, group } = fixture('')
    store.updateProjectGroup(group.id, {
      hookSettings: {
        mode: 'auto',
        commandSourcePolicy: 'shared-only',
        scripts: { setup: '', archive: '' }
      }
    })
    writeFileSync(
      join(testState.dir, 'orca.yaml'),
      'scripts:\n  archive: echo unseen > should-not-exist\n'
    )
    expect(
      await controller.deleteGroup(
        group.id,
        decision ? { archiveDecisions: { [group.id]: decision } } : {}
      )
    ).toEqual({ deleted: true })
    expect(existsSync(join(testState.dir, 'should-not-exist'))).toBe(false)
  })
})
