import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionRequest
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  GIT_KEY,
  addWorkspace,
  emptySession,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import type { Store } from '../persistence'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { adoptRuntimeTerminalOrphansFromInventory } from './runtime-terminal-orphan-adoption'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('electron', () => ({
  app: { getPath: () => testStateDirRef.dir, getName: () => 'orca', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => null },
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const testStateDirRef = vi.hoisted(() => ({ dir: '' }))

const REPO_ID = 'repo-1'
const ORPHAN_TAB = 'tab-orphan'
const ORPHAN_LEAF = leaf(2)
const ORPHAN_PANE = `${ORPHAN_TAB}:${ORPHAN_LEAF}`

function seededSession(revision: number | undefined): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-1', tabs: [{ id: 'tab-kept', leaves: [[leaf(1), 'pty-kept']] }] }
  ])
  return revision === undefined
    ? session
    : { ...session, terminalTopologyRevisionByRepoId: { [REPO_ID]: revision } }
}

/** The next profile write fails as a known (not indeterminate) disk failure. */
function failNextProfileWrite(): void {
  const fail = (): never => {
    throw new Error('disk_full')
  }
  for (const method of ['writeSerializedDomains', 'writeCompleteSerializedDomains'] as const) {
    vi.spyOn(ProfileStateSqliteAuthority.prototype, method).mockImplementationOnce(fail)
  }
}

function adoptWithFailingFlush(store: Store, revision: number): Promise<unknown> {
  failNextProfileWrite()
  return adopt(store, revision, (mutate) => store.runDurableMutation(mutate))
}

function adopt(
  store: Store,
  revision: number,
  runDurableMutation: Store['runDurableMutation'],
  host: { hostId: ExecutionHostId; connectionId: string | null } = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    connectionId: null
  }
): Promise<unknown> {
  const request: RuntimeTerminalOrphanAdoptionRequest = {
    worktree: GIT_KEY,
    expectedTopologyRevision: revision,
    claims: [
      {
        terminal: 'term-orphan',
        ptyId: 'pty-orphan',
        incarnationId: 'inc-orphan',
        tabId: ORPHAN_TAB,
        leafId: ORPHAN_LEAF
      }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads only these PTY fields.
  const pty = {
    ptyId: 'pty-orphan',
    incarnationId: 'inc-orphan',
    worktreeId: GIT_KEY,
    connectionId: host.connectionId,
    connected: true,
    tabId: null,
    paneKey: null
  } as RuntimePtyWorktreeRecord
  return adoptRuntimeTerminalOrphansFromInventory({
    hostId: host.hostId,
    request,
    workspace: {
      id: GIT_KEY,
      path: '/Users/dev/orca',
      connectionId: host.connectionId,
      repo: null,
      folderWorkspace: null
    },
    inventory: {
      livePtyIds: new Set(['pty-orphan']),
      allLivePtyIds: new Set(['pty-orphan']),
      terminalIdentityByPtyId: new Map([
        ['pty-orphan', { handle: 'term-orphan', incarnationId: 'inc-orphan', wslDistro: null }]
      ]),
      queriedHostIds: new Set([host.hostId])
    },
    repoId: REPO_ID,
    worktreeWslDistro: null,
    ports: {
      readSession: () => {
        const session = store.getWorkspaceSession(host.hostId)
        return {
          session,
          sessionWorktreeId: GIT_KEY,
          currentRevision: session.terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0
        }
      },
      getPty: () => pty,
      getLeaves: () => [],
      getLeaf: () => undefined,
      getDisplayTitle: () => null,
      replayPersistedSurface: vi.fn(),
      recordAdoptedSurface: vi.fn(),
      getMobileSnapshots: () => [],
      getSession: () => store.getWorkspaceSession(host.hostId),
      setSession: (_worktreeId, next) => store.setWorkspaceSession(next, host.hostId),
      runDurableMutation,
      flushSession: () => store.flushPendingOrThrowAsync(),
      hydrateSession: vi.fn(),
      notifySessionChanged: vi.fn(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller reads only `adopted`.
      getSnapshot: () => ({}) as RuntimeMobileSessionTabsResult
    }
  })
}

describe('orphan adoption whose flush fails', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-orphan-rollback-'))
    testStateDirRef.dir = testState.dir
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([
    ['a repo with no fence yet', undefined],
    ['a repo whose fence is armed', 3]
  ])('leaves no adopted tab, layout or incarnation behind in %s', async (_label, revision) => {
    const store = createStore()
    store.setWorkspaceSession(seededSession(revision))
    const before = store.getWorkspaceSession()

    await expect(adoptWithFailingFlush(store, revision ?? 0)).rejects.toThrow('disk_full')

    const after = store.getWorkspaceSession()
    expect(after.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual(['tab-kept'])
    expect(after.terminalLayoutsByTabId[ORPHAN_TAB]).toBeUndefined()
    expect(after.terminalPtyIncarnationsByPaneKey?.[ORPHAN_PANE]).toBeUndefined()
    expect(after.tabGroups?.[GIT_KEY]).toEqual(before.tabGroups?.[GIT_KEY])
  })

  it('keeps an unrelated edit that landed while it waited to write', async () => {
    const store = createStore()
    store.setWorkspaceSession(seededSession(3))

    const adoption = adopt(store, 3, (mutate) => {
      store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeTabId: 'tab-kept' })
      return store.runDurableMutation(mutate)
    })

    await expect(adoption).resolves.toMatchObject({ adopted: true })
    const after = store.getWorkspaceSession()
    expect(after.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual(['tab-kept', ORPHAN_TAB])
    expect(after.activeTabId).toBe('tab-kept')
  })

  it('refuses when a binding write queued ahead edited the session in place', async () => {
    const store = createStore()
    store.setWorkspaceSession(seededSession(3))

    const adoption = adopt(store, 3, (mutate) => {
      void store.persistPtyBinding({
        worktreeId: GIT_KEY,
        tabId: 'tab-bound',
        leafId: leaf(3),
        ptyId: 'pty-bound'
      })
      return store.runDurableMutation(mutate)
    })

    await expect(adoption).rejects.toThrow('terminal_topology_conflict')
    expect(store.getWorkspaceSession().tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual([
      'tab-kept',
      'tab-bound'
    ])
  })

  it('adopts into an SSH host partition that was never written', async () => {
    const store = createStore()
    const host = { hostId: toSshExecutionHostId('target-1'), connectionId: 'target-1' }

    const adoption = adopt(store, 0, (mutate) => store.runDurableMutation(mutate), host)

    await expect(adoption).resolves.toMatchObject({ adopted: true })
    expect(
      store.getWorkspaceSession(host.hostId).tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)
    ).toEqual([ORPHAN_TAB])
  })

  it('still rebases a renderer replay of the failed adoption away', async () => {
    const store = createStore()
    store.setWorkspaceSession(seededSession(3))
    await expect(adoptWithFailingFlush(store, 3)).rejects.toThrow('disk_full')
    const after = store.getWorkspaceSession()
    const keptTab = after.tabsByWorktree[GIT_KEY]![0]!
    const replay: WorkspaceSessionState = {
      ...after,
      tabsByWorktree: { [GIT_KEY]: [keptTab, { ...keptTab, id: ORPHAN_TAB, ptyId: 'pty-orphan' }] }
    }
    delete replay.terminalTopologyRevisionByRepoId

    store.setWorkspaceSession(replay)

    expect(store.getWorkspaceSession().tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual([
      'tab-kept'
    ])
  })
})
