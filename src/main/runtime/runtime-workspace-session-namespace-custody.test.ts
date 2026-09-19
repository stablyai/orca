import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type { LegacyWorkerRecoveryCandidate } from './runtime-legacy-worker-terminal-recovery-types'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import { hasMainOwnedRuntimeSessionNamespace } from './runtime-workspace-session-namespace-custody'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on() {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('../persistence/loading-store/store')
const cleanups: (() => void)[] = []
const HOST = 'runtime:historical-self-stamp'
const WORKTREE = 'repo-a::/audit/worktree'
const TAB = 'legacy-worker-tab'
const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE = `${TAB}:${LEAF}`
const INCARNATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
})

function fixture(hostId: ExecutionHostId, folder = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-session-namespace-'))
  const dataFile = join(dir, 'orca-data.json')
  const state = getDefaultPersistedState(dir)
  if (folder) {
    state.projectGroups = [
      {
        id: 'group-a',
        name: 'Audit group',
        parentPath: '/audit',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    state.folderWorkspaces = [
      {
        id: 'folder-a',
        projectGroupId: 'group-a',
        name: 'Audit folder',
        folderPath: '/audit',
        executionHostId: hostId,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 1,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  } else {
    state.repos = [
      {
        id: 'repo-a',
        path: '/audit',
        displayName: 'Audit',
        badgeColor: 'blue',
        addedAt: 1,
        executionHostId: hostId,
        kind: 'folder'
      }
    ]
  }
  writeFileSync(dataFile, JSON.stringify(state))
  const store = new Store({ dataFile })
  if (folder) {
    const declaredOwner = store.getFolderWorkspace('folder-a')
    if (!declaredOwner) {
      throw new Error('Folder fixture failed to load')
    }
    expect(declaredOwner.executionHostId).toBeUndefined()
    // This exercises explicit in-memory custody; load deliberately strips renderer host stamps.
    declaredOwner.executionHostId = hostId
  }
  cleanups.push(() => {
    store.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false
  })
  return { store, controller, workspaceId: folder ? 'folder:folder-a' : WORKTREE }
}

function session(workspaceId = WORKTREE): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeTabId: TAB,
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: TAB,
          worktreeId: workspaceId,
          ptyId: 'pty-a',
          title: 'Audit',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-a' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [PANE]: INCARNATION },
    sleepingAgentSessionsByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        tabId: TAB,
        worktreeId: workspaceId,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'audit-codex' },
        prompt: 'continue',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }
}

function candidate(): LegacyWorkerRecoveryCandidate {
  return {
    dispatchId: 'dispatch-a',
    dispatchStatus: 'dispatched',
    contractVersion: 1,
    taskId: 'task-a',
    worktreeId: WORKTREE,
    terminalHandle: 'term-a',
    paneKey: PANE,
    tabId: TAB,
    leafId: LEAF,
    processIncarnation: `pty-a:${INCARNATION}`,
    ptyId: 'pty-a',
    incarnationId: INCARNATION
  }
}

describe('main workspace session namespace custody', () => {
  it.each([false, true])(
    'preserves a main-declared namespace before its first session write with folder=%s',
    (folder) => {
      const { store, controller, workspaceId } = fixture(HOST, folder)
      expect(store.getWorkspaceSessionHostIds()).not.toContain(HOST)
      expect(controller.getHostId(workspaceId)).toBe(HOST)
      expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(true)
    }
  )

  it.each([false, true])('follows the actual unique persisted alias with folder=%s', (folder) => {
    const { store, controller, workspaceId } = fixture('runtime:new-stamp', folder)
    store.setWorkspaceSession(session(workspaceId), HOST)
    expect(controller.getHostId(workspaceId)).toBe(HOST)
    expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(true)
    store.setWorkspaceSession(session(workspaceId), 'runtime:second-alias')
    expect(controller.getHostId(workspaceId)).toBe('runtime:new-stamp')
    expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(false)
  })

  it.each(['local', 'ssh:direct-target'] as const)(
    'does not adopt same-ID tabs from %s',
    (preferred) => {
      const { store, controller } = fixture(preferred)
      store.setWorkspaceSession(session(), HOST)
      expect(controller.getHostId(WORKTREE)).toBe(preferred)
      expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(false)
    }
  )

  it('re-evaluates current catalog custody and removes only the exact runtime partition', () => {
    const { store } = fixture(HOST)
    for (const hostId of [HOST, 'runtime:sibling', 'local', 'ssh:direct-target']) {
      store.setWorkspaceSession(session(), hostId)
    }
    expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(true)
    store.removeProjectForHost('repo-a', HOST)
    expect(hasMainOwnedRuntimeSessionNamespace(store, HOST)).toBe(false)
    expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).toBe(true)
    expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).toBe(false)
    expect(store.removeRuntimeWorkspaceSessionPartition('local')).toBe(false)
    expect(store.removeRuntimeWorkspaceSessionPartition('ssh:direct-target')).toBe(false)
    expect(store.getWorkspaceSessionHostIds()).toEqual([
      'local',
      'runtime:sibling',
      'ssh:direct-target'
    ])
  })
})

describe('legacy recovery rollback partition presence', () => {
  it.each(['local', 'ssh:direct-target', HOST] as const)(
    'restores adopted state in existing %s',
    async (hostId) => {
      const { store, controller } = fixture(hostId)
      store.setWorkspaceSession(session(), hostId)
      vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValue(
        new Error('controlled write failure')
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => store,
        () => {
          throw new Error('Unexpected database access')
        },
        (id) => controller.tryGetHostId(id)
      )
      await expect(
        recovery.persist([{ candidate: candidate(), resolution: 'adopted' }])
      ).resolves.toEqual(new Set())
      expect(store.getWorkspaceSession(hostId).sleepingAgentSessionsByPaneKey?.[PANE]?.prompt).toBe(
        'continue'
      )
      expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId[TAB]).toBeDefined()
    }
  )

  it.each(['adopted', 'exited'] as const)(
    'keeps explicit partition removal after a failed %s write',
    async (resolution) => {
      const { store, controller } = fixture(HOST)
      store.setWorkspaceSession(session(), HOST)
      let rejectFlush: (reason: Error) => void = () => {
        throw new Error('Flush not started')
      }
      vi.spyOn(store, 'flushPendingOrThrowAsync').mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          rejectFlush = reject
        })
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => store,
        () => {
          throw new Error('Unexpected database access')
        },
        (id) => controller.tryGetHostId(id)
      )
      const work = recovery.persist([{ candidate: candidate(), resolution }])
      store.removeProjectForHost('repo-a', HOST)
      expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).toBe(true)
      rejectFlush(new Error('controlled write failure'))
      await expect(work).resolves.toEqual(new Set())
      expect(store.getWorkspaceSessionHostIds()).not.toContain(HOST)
    }
  )
})
