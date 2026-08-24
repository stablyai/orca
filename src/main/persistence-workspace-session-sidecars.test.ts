import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { normalizeExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import type * as NodeFsPromises from 'node:fs/promises'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import {
  WorkspaceSessionSidecarStore,
  getWorkspaceSessionPartitionFile,
  replaceWorkspaceSessionSidecarsSync,
  type WorkspaceSessionPartitionTrace
} from './persistence/loading-store/workspace-session-sidecar'
import {
  createStore,
  dataFile,
  makeTerminalTab,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { TEST_LEAF_1, makeSessionWithBrowserHistory } from './persistence-session-fixtures'
import { flushActiveProfileBeforeFileMutation } from './orca-profiles/profile-persistence-deadline'

const coreRenameGate = vi.hoisted(() => ({
  release: null as Promise<void> | null,
  started: null as (() => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (source: NodeFs.PathLike, destination: NodeFs.PathLike) => {
      if (
        coreRenameGate.release &&
        typeof destination === 'string' &&
        destination.endsWith('/orca-data.json')
      ) {
        const release = coreRenameGate.release
        coreRenameGate.release = null
        coreRenameGate.started?.()
        await release
      }
      return actual.rename(source, destination)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace(/^encrypted:/, '')
  }
}))

function session(activeRepoId: string): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), activeRepoId }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function delayNextCoreRename(): { release: () => void; started: Promise<void> } {
  const release = deferred()
  const started = deferred()
  coreRenameGate.release = release.promise
  coreRenameGate.started = started.resolve
  return { release: release.resolve, started: started.promise }
}
function boundSession(repoId: string, worktreeId: string, tabId: string, ptyId: string) {
  return {
    ...session(repoId),
    tabsByWorktree: {
      [worktreeId]: [makeTerminalTab({ id: tabId, worktreeId, ptyId })]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: ptyId }
      }
    }
  }
}

function readPartition(hostId: ExecutionHostId): {
  hostId: ExecutionHostId
  writeGeneration: number
  session: WorkspaceSessionState
} {
  return JSON.parse(
    readFileSync(getWorkspaceSessionPartitionFile(dataFile(), hostId), 'utf-8')
  ) as {
    hostId: ExecutionHostId
    writeGeneration: number
    session: WorkspaceSessionState
  }
}

describe('workspace session sidecars', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-session-sidecar-'))
    coreRenameGate.release = null
    coreRenameGate.started = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps an ordinary host patch off the core projection and serializes only that host', async () => {
    const seed = await createStore()
    seed.flush()

    const serializedHosts: ExecutionHostId[] = []
    const store = await createStore({
      workspaceSessionSidecars: {
        serialize: (value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('hostId' in value) ||
            typeof value.hostId !== 'string'
          ) {
            throw new Error('missing partition host id')
          }
          const hostId = normalizeExecutionHostId(value.hostId)
          if (!hostId) {
            throw new Error('invalid partition host id')
          }
          serializedHosts.push(hostId)
          return JSON.stringify(value)
        }
      }
    })
    store.setWorkspaceSession(session('repo-a'), 'runtime:host-a')
    store.setWorkspaceSession(session('repo-b'), 'ssh:host-b')
    await store.flushPendingOrThrowAsync()
    serializedHosts.length = 0

    const buildStateToSave = vi.spyOn(
      store as unknown as { buildStateToSave: () => unknown },
      'buildStateToSave'
    )
    store.patchWorkspaceSession({ activeTabId: 'tab-a' }, 'runtime:host-a')
    await store.waitForPendingWrite()

    expect(buildStateToSave).not.toHaveBeenCalled()
    expect(serializedHosts).toEqual(['runtime:host-a'])
    expect(readPartition('runtime:host-a').session).toMatchObject({
      activeRepoId: 'repo-a',
      activeTabId: 'tab-a'
    })
    expect(readPartition('ssh:host-b').session.activeRepoId).toBe('repo-b')
    buildStateToSave.mockRestore()
    store.flush()
    const core = readDataFile()
    expect(core).toHaveProperty('workspaceSession')
    expect(core).toHaveProperty('workspaceSessionsByHostId')
  })

  it('uses write generations so a patch racing a flush cannot install torn or stale state', async () => {
    let injectConcurrentPatch = false
    const traces: WorkspaceSessionPartitionTrace[] = []
    let sidecars!: WorkspaceSessionSidecarStore
    sidecars = new WorkspaceSessionSidecarStore(dataFile(), {
      serialize: (value) => {
        if (injectConcurrentPatch) {
          injectConcurrentPatch = false
          sidecars.markDirty('runtime:host-a', session('newest'), 'patch')
        }
        return JSON.stringify(value)
      },
      onTrace: (trace) => {
        traces.push(trace)
      }
    })
    sidecars.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    sidecars.initialize(session('local'), {})
    sidecars.markDirty('runtime:host-a', session('stale'), 'patch')
    injectConcurrentPatch = true
    await sidecars.flushPending({ drainToStableGeneration: true })

    const installed = readPartition('runtime:host-a')
    expect(installed.session.activeRepoId).toBe('newest')
    expect(installed.writeGeneration).toBe(2)
    expect(() =>
      JSON.parse(
        readFileSync(getWorkspaceSessionPartitionFile(dataFile(), 'runtime:host-a'), 'utf-8')
      )
    ).not.toThrow()
    expect(traces.at(-1)).toMatchObject({
      hostId: 'runtime:host-a',
      partitionBytes: expect.any(Number),
      durationMs: expect.any(Number),
      trigger: 'patch',
      writeGeneration: 2,
      committed: true
    })
  })

  it('bounds an ordinary flush to its captured generation under continuous churn', async () => {
    let serializations = 0
    let sidecars!: WorkspaceSessionSidecarStore
    sidecars = new WorkspaceSessionSidecarStore(dataFile(), {
      serialize: (value) => {
        serializations++
        sidecars.markDirty('runtime:churn', session(`newer-${serializations}`), 'patch')
        return JSON.stringify(value)
      }
    })
    sidecars.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    sidecars.initialize(session('local'), {})
    sidecars.markDirty('runtime:churn', session('captured'), 'patch')

    await sidecars.flushPending({ drainToStableGeneration: false })

    expect(serializations).toBe(1)
    expect(readPartition('runtime:churn').session.activeRepoId).toBe('captured')
    sidecars.freeze()
  })

  it('retries transient sidecar failures but bounds permanent failures', async () => {
    let attempts = 0
    const sidecars = new WorkspaceSessionSidecarStore(dataFile(), {
      serialize: (value) => {
        attempts++
        if (attempts <= 2) {
          throw new Error('transient disk failure')
        }
        return JSON.stringify(value)
      }
    })
    sidecars.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    sidecars.initialize(session('local'), {})
    sidecars.markDirty('runtime:retry', session('retry-ok'), 'patch')
    await sidecars.flushPending({ drainToStableGeneration: true })
    expect(attempts).toBe(3)
    expect(readPartition('runtime:retry').session.activeRepoId).toBe('retry-ok')
    let permanentAttempts = 0

    const permanent = new WorkspaceSessionSidecarStore(dataFile(), {
      serialize: () => {
        permanentAttempts++
        throw new Error('permanent disk failure')
      }
    })
    permanent.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    permanent.initialize(session('local'), {})
    permanent.markDirty('runtime:permanent', session('never-written'), 'patch')
    await expect(permanent.flushPending({ drainToStableGeneration: true })).rejects.toThrow(
      'permanent disk failure'
    )
    expect(permanentAttempts).toBe(6)
    permanent.freeze()
  })

  it('round-trips a supported rollback through the embedded compatibility projection', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: session('local-legacy'),
      workspaceSessionsByHostId: {
        'runtime:host-a': session('remote-legacy')
      }
    })

    const store = await createStore()
    await store.flushPendingOrThrowAsync()

    expect(readPartition('local').session.activeRepoId).toBe('local-legacy')
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('remote-legacy')
    const rollbackCore = readDataFile() as {
      workspaceSession: WorkspaceSessionState
      workspaceSessionsByHostId: Record<ExecutionHostId, WorkspaceSessionState>
      workspaceSessionSidecarGenerationByHostId?: unknown
    }
    rollbackCore.workspaceSession.activeRepoId = 'rollback-local'
    rollbackCore.workspaceSessionsByHostId['runtime:host-a'].activeRepoId = 'rollback-remote'
    delete rollbackCore.workspaceSessionSidecarGenerationByHostId
    writeDataFile(rollbackCore)

    const returned = await createStore()
    expect(returned.getWorkspaceSession('local').activeRepoId).toBe('rollback-local')
    expect(returned.getWorkspaceSession('runtime:host-a').activeRepoId).toBe('rollback-remote')
    await returned.flushPendingOrThrowAsync()
    expect(readPartition('local').session.activeRepoId).toBe('rollback-local')
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('rollback-remote')
  })

  it('keeps a newer sidecar when an old build rewrites an unchanged embedded projection', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: session('local-v1'),
      workspaceSessionsByHostId: {
        'runtime:host-a': session('remote-v1')
      }
    })

    const store = await createStore()
    await store.flushPendingOrThrowAsync({ syncCompatibilityProjection: true })
    const oldBuildCore = readDataFile() as {
      workspaceSessionSidecarGenerationByHostId?: unknown
    }

    store.patchWorkspaceSession({ activeRepoId: 'remote-v2' }, 'runtime:host-a')
    await store.flushPendingOrThrowAsync()
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('remote-v2')

    // A rollback build can preserve the embedded payload byte-for-byte while dropping
    // sidecar metadata it does not understand. That must not look like an intentional edit.
    delete oldBuildCore.workspaceSessionSidecarGenerationByHostId
    writeDataFile(oldBuildCore)

    const returned = await createStore()
    expect(returned.getWorkspaceSession('runtime:host-a').activeRepoId).toBe('remote-v2')
  })

  it('leaves embedded data intact when its migration cannot become durable', async () => {
    writeDataFile({ schemaVersion: 1, workspaceSession: session('must-survive') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await createStore({
      workspaceSessionSidecars: {
        serialize: () => {
          throw new Error('disk unavailable')
        }
      }
    })
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('disk unavailable')
    const persisted = readDataFile()
    expect(
      persisted && typeof persisted === 'object' && 'workspaceSession' in persisted
        ? persisted.workspaceSession
        : undefined
    ).toMatchObject({ activeRepoId: 'must-survive' })
    expect(error).toHaveBeenCalled()
  })

  it('recovers corrupt and missing primaries from per-host backups without crossing hosts', async () => {
    const sidecars = new WorkspaceSessionSidecarStore(dataFile())
    sidecars.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    sidecars.initialize(session('local'), {})
    sidecars.markDirty('runtime:corrupt', session('corrupt-backup'), 'replace')
    sidecars.markDirty('ssh:missing', session('missing-backup'), 'replace')
    await sidecars.flushPending()
    sidecars.markDirty('runtime:corrupt', session('corrupt-newer'), 'replace')
    sidecars.markDirty('ssh:missing', session('missing-newer'), 'replace')
    await sidecars.flushPending()

    writeFileSync(getWorkspaceSessionPartitionFile(dataFile(), 'runtime:corrupt'), '{', 'utf-8')
    unlinkSync(getWorkspaceSessionPartitionFile(dataFile(), 'ssh:missing'))
    const recovered = new WorkspaceSessionSidecarStore(dataFile()).resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })

    expect(recovered.workspaceSessionsByHostId['runtime:corrupt']?.activeRepoId).toBe(
      'corrupt-backup'
    )
    expect(recovered.workspaceSessionsByHostId['ssh:missing']?.activeRepoId).toBe('missing-backup')
    expect(recovered.workspaceSession.activeRepoId).toBe('local')
  })

  it('prunes removed host files only after replacement sidecars are durable', () => {
    replaceWorkspaceSessionSidecarsSync({
      dataFile: dataFile(),
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {
        'runtime:keep': session('keep'),
        'ssh:remove': session('remove')
      }
    })
    replaceWorkspaceSessionSidecarsSync({
      dataFile: dataFile(),
      workspaceSession: session('local-next'),
      workspaceSessionsByHostId: { 'runtime:keep': session('keep-next') }
    })

    expect(readPartition('runtime:keep').session.activeRepoId).toBe('keep-next')
    expect(() => readPartition('ssh:remove')).toThrow()
  })

  it('prefers valid newer sidecars when the core profile is restored from a stale backup', async () => {
    writeDataFile({ schemaVersion: 1, workspaceSession: session('stale-core') })
    const store = await createStore()
    await store.flushPendingOrThrowAsync()
    const staleCore = readFileSync(dataFile(), 'utf-8')

    store.patchWorkspaceSession({ activeRepoId: 'newer-sidecar' }, 'local')
    await store.waitForPendingWrite()
    store.freezeWrites()
    writeFileSync(`${dataFile()}.bak.0`, staleCore, 'utf-8')
    writeFileSync(dataFile(), '{', 'utf-8')

    const restored = await createStore()
    expect(restored.getWorkspaceSession('local').activeRepoId).toBe('newer-sidecar')
  })

  it('propagates identity, folder removal, and group cascade mutations to sidecars', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Folder group',
      parentPath: '/workspace/folders',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder workspace'
    })
    const folderKey = folderWorkspaceKey(workspace.id)
    store.setWorkspaceSession({
      ...session('local'),
      tabsByWorktree: {
        [folderKey]: [makeTerminalTab({ id: 'folder-tab', worktreeId: folderKey })]
      }
    })
    await store.flushPendingOrThrowAsync()
    store.removeFolderWorkspace(workspace.id)
    await store.waitForPendingWrite()
    expect(readPartition('local').session.tabsByWorktree[folderKey]).toBeUndefined()

    const cascadeGroup = store.createProjectGroup({
      name: 'Cascade group',
      parentPath: '/workspace/cascade',
      createdFrom: 'folder-scan'
    })
    const cascade = store.createFolderWorkspace({
      projectGroupId: cascadeGroup.id,
      name: 'Cascade workspace'
    })
    const cascadeKey = folderWorkspaceKey(cascade.id)
    store.patchWorkspaceSession({
      tabsByWorktree: {
        [cascadeKey]: [makeTerminalTab({ id: 'cascade-tab', worktreeId: cascadeKey })]
      }
    })
    await store.flushPendingOrThrowAsync()
    store.deleteProjectGroup(cascadeGroup.id)
    await store.waitForPendingWrite()
    expect(readPartition('local').session.tabsByWorktree[cascadeKey]).toBeUndefined()

    const oldWorktreeId = 'repo::/workspace/old'
    const newWorktreeId = 'repo::/workspace/new'
    const oldSession = {
      ...session('repo'),

      tabsByWorktree: {
        [oldWorktreeId]: [makeTerminalTab({ id: 'rename-tab', worktreeId: oldWorktreeId })]
      }
    }
    store.setWorkspaceSession(structuredClone(oldSession), 'local')
    store.setWorkspaceSession(structuredClone(oldSession), 'runtime:rename-host')
    await store.flushPendingOrThrowAsync()
    store.migrateWorktreeIdentity(oldWorktreeId, newWorktreeId)
    await store.waitForPendingWrite()

    expect(readPartition('local').session.tabsByWorktree[newWorktreeId]).toHaveLength(1)
    expect(readPartition('runtime:rename-host').session.tabsByWorktree[newWorktreeId]).toHaveLength(
      1
    )
    store.flush()
  })

  it('rewrites sidecars when load-time pane normalization changes their session state', async () => {
    const worktreeId = 'repo::/workspace/legacy-pane'
    const legacySession: WorkspaceSessionState = {
      ...session('repo'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'legacy-tab', worktreeId, ptyId: 'legacy-pty' })]
      },
      terminalLayoutsByTabId: {
        'legacy-tab': {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'legacy-pty' }
        }
      }
    }
    writeDataFile({ schemaVersion: 1 })
    replaceWorkspaceSessionSidecarsSync({
      dataFile: dataFile(),
      workspaceSession: legacySession
    })

    await createStore()

    const root = readPartition('local').session.terminalLayoutsByTabId['legacy-tab']?.root
    expect(root?.type === 'leaf' ? root.leafId : null).not.toBe('pane:1')
  })

  it('republishes load-time host-session pruning to its sidecar', async () => {
    writeDataFile({ schemaVersion: 1 })
    replaceWorkspaceSessionSidecarsSync({
      dataFile: dataFile(),
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {
        'runtime:history': makeSessionWithBrowserHistory(500)
      }
    })

    const store = await createStore()
    await store.waitForPendingWrite()
    expect(store.getWorkspaceSession('runtime:history').browserUrlHistory).toHaveLength(200)

    expect(readPartition('runtime:history').session.browserUrlHistory).toHaveLength(200)
  })
  it('does not rewrite normalized histories on many-host startup and republishes only one change', async () => {
    const seed = await createStore()
    const hostIds = Array.from({ length: 8 }, (_, index) => `runtime:history-${index}` as const)
    for (const hostId of hostIds) {
      seed.setWorkspaceSession(makeSessionWithBrowserHistory(3), hostId)
    }
    await seed.flushPendingOrThrowAsync({ syncCompatibilityProjection: true })
    const canonicalizer = await createStore()
    await canonicalizer.waitForPendingWrite()
    const canonicalCore = readFileSync(dataFile(), 'utf-8')
    const generations = Object.fromEntries(
      hostIds.map((hostId) => [hostId, readPartition(hostId).writeGeneration])
    )

    const cleanReload = await createStore()
    await cleanReload.waitForPendingWrite()
    expect(readFileSync(dataFile(), 'utf-8')).toBe(canonicalCore)
    for (const hostId of hostIds) {
      expect(readPartition(hostId).writeGeneration).toBe(generations[hostId])
    }

    const external = new WorkspaceSessionSidecarStore(dataFile())
    external.resolveForLoad({
      workspaceSession: session('local'),
      workspaceSessionsByHostId: {},
      embeddedLocalPresent: false,
      embeddedHostIds: new Set(),
      embeddedPayloadPresent: false
    })
    external.markDirty(hostIds[3], makeSessionWithBrowserHistory(500), 'patch')
    external.flushSync()
    const changedGeneration = readPartition(hostIds[3]).writeGeneration

    const migrated = await createStore()
    await migrated.waitForPendingWrite()
    expect(readPartition(hostIds[3]).writeGeneration).toBe(changedGeneration + 1)
    for (const hostId of hostIds.filter((hostId) => hostId !== hostIds[3])) {
      expect(readPartition(hostId).writeGeneration).toBe(generations[hostId])
    }
  })
  it('persists lease and target binding cleanup to only the affected host sidecars', async () => {
    const store = await createStore()
    store.setWorkspaceSession(boundSession('local', 'local-wt', 'local-tab', 'local-pty'), 'local')
    store.setWorkspaceSession(
      boundSession('ssh-a', 'ssh-a-wt', 'ssh-a-tab', 'ssh-a-pty'),
      'ssh:ssh-a'
    )
    store.setWorkspaceSession(
      boundSession('ssh-b', 'ssh-b-wt', 'ssh-b-tab', 'ssh-b-pty'),
      'ssh:ssh-b'
    )
    for (const [targetId, worktreeId, tabId, ptyId] of [
      ['ssh-a', 'ssh-a-wt', 'ssh-a-tab', 'ssh-a-pty'],
      ['ssh-b', 'ssh-b-wt', 'ssh-b-tab', 'ssh-b-pty']
    ] as const) {
      store.upsertSshRemotePtyLease({
        targetId,
        ptyId,
        worktreeId,
        tabId,
        leafId: TEST_LEAF_1,
        state: 'detached'
      })
    }
    await store.flushPendingOrThrowAsync()

    store.removeSshRemotePtyLease('ssh-a', 'ssh-a-pty')
    store.removeSshRemotePtyLeases('ssh-b')
    await store.flushPendingOrThrowAsync()

    const reloaded = await createStore()
    expect(
      reloaded.getWorkspaceSession('ssh:ssh-a').terminalLayoutsByTabId['ssh-a-tab'].ptyIdsByLeafId
    ).toEqual({})
    expect(
      reloaded.getWorkspaceSession('ssh:ssh-b').terminalLayoutsByTabId['ssh-b-tab'].ptyIdsByLeafId
    ).toEqual({})
    expect(
      reloaded.getWorkspaceSession('local').terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId
    ).toEqual({ [TEST_LEAF_1]: 'local-pty' })
  })

  it('reassigns and prunes an SSH host sidecar without disturbing other hosts', async () => {
    const store = await createStore()
    store.setWorkspaceSession(session('local-stable'), 'local')
    store.setWorkspaceSession(session('old-host'), 'ssh:ssh-old')
    store.setWorkspaceSession(session('other-host'), 'ssh:ssh-other')
    await store.flushPendingOrThrowAsync()

    store.patchWorkspaceSession({ activeTabId: 'latest-old' }, 'ssh:ssh-old')
    store.reassignSshTargetId('ssh-old', 'ssh-new')
    await flushActiveProfileBeforeFileMutation(store)
    store.freezeWrites()

    expect(() => readPartition('ssh:ssh-old')).toThrow()
    expect(readPartition('ssh:ssh-new').session).toMatchObject({
      activeRepoId: 'old-host',
      activeTabId: 'latest-old'
    })
    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession('ssh:ssh-new').activeTabId).toBe('latest-old')
    expect(reloaded.getWorkspaceSession('ssh:ssh-other').activeRepoId).toBe('other-host')
    expect(reloaded.getWorkspaceSession('local').activeRepoId).toBe('local-stable')
  })

  it('profile-transfer barrier retries when a session changes during its core rename', async () => {
    const store = await createStore()
    store.setWorkspaceSession(session('profile-v0'), 'runtime:host-a')
    await store.flushPendingOrThrowAsync({ syncCompatibilityProjection: true })

    const rename = delayNextCoreRename()
    store.patchWorkspaceSession({ activeRepoId: 'profile-v1' }, 'runtime:host-a')
    const barrier = flushActiveProfileBeforeFileMutation(store)
    await rename.started

    store.patchWorkspaceSession({ activeRepoId: 'profile-v2' }, 'runtime:host-a')
    rename.release()
    await barrier
    store.freezeWrites()

    const core = readDataFile() as {
      workspaceSessionsByHostId: Record<ExecutionHostId, WorkspaceSessionState>
    }
    expect(core.workspaceSessionsByHostId['runtime:host-a'].activeRepoId).toBe('profile-v2')
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('profile-v2')
  })

  it('quit retries after a pre-quit session patch races an in-flight core rename', async () => {
    const store = await createStore()
    store.setWorkspaceSession(session('quit-v0'), 'runtime:host-a')
    await store.flushPendingOrThrowAsync({ syncCompatibilityProjection: true })

    const rename = delayNextCoreRename()
    store.updateSettings({ branchPrefix: 'none' })
    const staleCoreWrite = store.flushPendingOrThrowAsync()
    await rename.started

    store.patchWorkspaceSession({ activeRepoId: 'quit-v1' }, 'runtime:host-a')
    const quit = store.flushAsync()
    rename.release()
    await staleCoreWrite
    await quit

    const core = readDataFile() as {
      workspaceSessionsByHostId: Record<ExecutionHostId, WorkspaceSessionState>
    }
    expect(core.workspaceSessionsByHostId['runtime:host-a'].activeRepoId).toBe('quit-v1')
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('quit-v1')
  })
  it('quit and profile-switch barriers resolve only after the latest sidecar is readable', async () => {
    const seed = await createStore()
    seed.flush()
    const store = await createStore()
    store.patchWorkspaceSession({ activeRepoId: 'profile-switch' }, 'runtime:host-a')

    await store.flushPendingOrThrowAsync()
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('profile-switch')

    store.patchWorkspaceSession({ activeRepoId: 'quit' }, 'runtime:host-a')
    await store.flushAsync()
    expect(readPartition('runtime:host-a').session.activeRepoId).toBe('quit')
  })
})
