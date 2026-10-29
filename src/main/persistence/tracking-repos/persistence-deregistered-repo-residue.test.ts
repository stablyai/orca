import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo
} from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
// Deregistered repos bypass missing-directory pruning, so residue needs its own sweep.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({})
}))

const LIVE_REPO = 'live-repo'
const GONE_REPO = 'gone-repo'
const LIVE_WORKTREE = `${LIVE_REPO}::/workspace/live`
const GONE_WORKTREE = `${GONE_REPO}::/workspace/orphan`
const RUNTIME_HOST = 'runtime:env-a'

const sleepingAgentFor = (worktreeId: string, tabId = 'tab-1') => ({
  [`${tabId}:leaf-1`]: {
    paneKey: `${tabId}:leaf-1`,
    tabId,
    worktreeId,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'sess-1' },
    prompt: 'sleeping',
    state: 'waiting' as const,
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep' as const
  }
})

const sessionFor = (worktreeId: string, tabId = 'tab-1') => ({
  ...getDefaultWorkspaceSession(),
  tabsByWorktree: {
    [worktreeId]: [makeTerminalTab({ id: tabId, worktreeId })]
  },
  activeTabTypeByWorktree: { [worktreeId]: 'terminal' as const },
  lastVisitedAtByWorktreeId: { [worktreeId]: 123 },
  sleepingAgentSessionsByPaneKey: sleepingAgentFor(worktreeId, tabId)
})

describe('deregistered repo residue', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-orphan-sweep-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('drops metadata, identity rows and sessions owned by an unregistered repo id', async () => {
    const seed = await createStore()
    seed.addRepo(makeRepo({ id: LIVE_REPO, path: '/workspace/live' }))
    seed.addRepo(makeRepo({ id: GONE_REPO, path: '/workspace/orphan' }))
    seed.setWorktreeMeta(hostWorktreeTarget({ id: LIVE_WORKTREE, hostId: 'local' }), {
      displayName: 'Live'
    })
    seed.setWorktreeMeta(hostWorktreeTarget({ id: GONE_WORKTREE, hostId: 'local' }), {
      displayName: 'Orphan'
    })
    seed.setWorkspaceSession(sessionFor(GONE_WORKTREE), 'local')
    seed.flush()

    const persisted = readDataFile() as PersistedState
    persisted.repos = persisted.repos.filter((repo) => repo.id !== GONE_REPO)
    writeDataFile(persisted)

    const reloaded = await createStore()
    reloaded.flush()
    const swept = readDataFile() as PersistedState

    expect(Object.keys(swept.worktreeMeta)).toEqual([LIVE_WORKTREE])
    expect(swept.worktreeIdentityAliases).not.toHaveProperty(
      composeWorktreeHostIdentity('local', GONE_WORKTREE)
    )
    expect(Object.keys(swept.worktreeMetaByIdentity ?? {})).toHaveLength(1)
    const session = swept.workspaceSession
    expect(session.tabsByWorktree).toEqual({})
    expect(session.lastVisitedAtByWorktreeId).toEqual({})
    expect(session.activeTabTypeByWorktree).toEqual({})
    expect(session.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
  })

  it('keeps a remote session whose repo is not registered on the desktop', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/workspace/live' })],
      worktreeMeta: {},
      workspaceSessionsByHostId: {
        [RUNTIME_HOST]: sessionFor(GONE_WORKTREE)
      }
    })

    const store = await createStore()
    store.flush()

    const partition = store.getWorkspaceSession(RUNTIME_HOST)
    expect(partition.tabsByWorktree[GONE_WORKTREE]).toHaveLength(1)
    expect(partition.activeTabTypeByWorktree).toEqual(
      sessionFor(GONE_WORKTREE).activeTabTypeByWorktree
    )
  })

  it('keeps rows for every registered repo, on any execution host', async () => {
    const remoteWorktree = `${LIVE_REPO}::/home/user/remote`
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/home/user/live', executionHostId: RUNTIME_HOST })],
      worktreeMeta: { [remoteWorktree]: { hostId: RUNTIME_HOST, status: 'active' } },
      workspaceSessionsByHostId: { [RUNTIME_HOST]: sessionFor(remoteWorktree) }
    })

    const store = await createStore()

    expect(store.getWorktreeMeta(remoteWorktree)).toBeDefined()
    const partition = store.getWorkspaceSession(RUNTIME_HOST)
    expect(partition.tabsByWorktree[remoteWorktree]).toHaveLength(1)
    // Prove the sleeping-agent fixture is valid before relying on its absence elsewhere.
    expect(Object.keys(partition.sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
  })

  it('leaves folder-workspace session rows alone: their keys name no repo', async () => {
    const workspaceKey = folderWorkspaceKey('folder-1')
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { [workspaceKey]: 7 }
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('local').lastVisitedAtByWorktreeId).toEqual({
      [workspaceKey]: 7
    })
  })

  // Pane-keyed values must seed the sweep even when no worktree-keyed residue remains.
  it("drops a sleeping agent that is the orphan repo's only residue, and self-clears", async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/workspace/live' })],
      worktreeMeta: {},
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: sleepingAgentFor(GONE_WORKTREE)
      }
    })

    const store = await createStore()
    store.flush()
    expect(store.getWorkspaceSession('local').sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
    // Verify disk cleanup first; otherwise the next load could repeat it and falsely appear self-clearing.
    const persisted = readDataFile() as PersistedState
    expect(persisted.workspaceSession.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})

    const reloaded = await createStore()
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
  })

  // Close records name workspaces only in values and must seed orphan detection themselves.
  it("drops a close record that is the orphan repo's only residue, and self-clears", async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/workspace/live' })],
      worktreeMeta: {},
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        closedTerminalTabTombstonesByTabId: {
          'tab-gone': { worktreeId: GONE_WORKTREE, closedAt: Date.now(), reason: 'user' },
          'tab-live': { worktreeId: LIVE_WORKTREE, closedAt: Date.now(), reason: 'user' }
        }
      }
    })

    const store = await createStore()
    store.flush()
    expect(
      Object.keys(store.getWorkspaceSession('local').closedTerminalTabTombstonesByTabId ?? {})
    ).toEqual(['tab-live'])
    const reloaded = await createStore()
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
  })

  // Scalars must independently seed orphan detection; owner-key loops cannot reach them.
  it.each([
    { label: 'activeWorktreeId', session: { activeWorktreeId: GONE_WORKTREE } },
    {
      label: 'activeWorkspaceKey',
      session: { activeWorkspaceKey: worktreeWorkspaceKey(GONE_WORKTREE) }
    },
    {
      label: 'activeWorktreeIdsOnShutdown',
      session: { activeWorktreeIdsOnShutdown: [GONE_WORKTREE] }
    }
  ])("clears $label when it is the orphan repo's only residue", async ({ session }) => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/workspace/live' })],
      worktreeMeta: {},
      workspaceSession: { ...getDefaultWorkspaceSession(), ...session }
    })

    const store = await createStore()
    store.flush()

    const partition = store.getWorkspaceSession()
    expect(partition.activeWorktreeId ?? null).toBeNull()
    expect(partition.activeWorkspaceKey ?? null).toBeNull()
    expect(partition.activeWorktreeIdsOnShutdown ?? []).toEqual([])
    const reloaded = await createStore()
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
  })

  it('leaves a profile with no orphans byte-identical across reloads', async () => {
    const seed = await createStore()
    seed.addRepo(makeRepo({ id: LIVE_REPO, path: '/workspace/live' }))
    seed.setWorktreeMeta(hostWorktreeTarget({ id: LIVE_WORKTREE, hostId: 'local' }), {
      displayName: 'Live'
    })
    seed.setWorkspaceSession(sessionFor(LIVE_WORKTREE), 'local')
    seed.flush()

    const canonicalizing = await createStore()
    canonicalizing.flush()
    const canonical = JSON.stringify(readDataFile())

    const reloaded = await createStore()
    reloaded.flush()

    expect(JSON.stringify(readDataFile())).toBe(canonical)
  })
})
