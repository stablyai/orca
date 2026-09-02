// Why this file exists: deregistering a project used to strand every row it owned. No sweeper could
// reach them -- the missing-directory prune is gated on the repo still being registered, and a
// paired client's mirror of a remote host's rows is keyed by ids that client never registers, so the
// owning host's removal never reached it (#17776).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

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
  // The residue `profile-project-session-field-disposition` flags as leaking on repo removal.
  sleepingAgentSessionsByPaneKey: sleepingAgentFor(worktreeId, tabId)
})

describe('deregistered repo residue', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-orphan-sweep-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('drops metadata, identity rows and sessions owned by an unregistered repo id', async () => {
    const seed = await createStore()
    seed.addRepo(makeRepo({ id: LIVE_REPO, path: '/workspace/live' }))
    seed.addRepo(makeRepo({ id: GONE_REPO, path: '/workspace/orphan' }))
    seed.setWorktreeMetaForHost(LIVE_WORKTREE, 'local', { displayName: 'Live' })
    seed.setWorktreeMetaForHost(GONE_WORKTREE, 'local', { displayName: 'Orphan' })
    seed.setWorkspaceSession(sessionFor(GONE_WORKTREE), 'local')
    seed.flush()

    // Deregister by hand: the point is that a row can outlive its repo however that happened.
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

  it("sweeps a remote host's session partition the owning host's removal can never reach", async () => {
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
    expect(partition.tabsByWorktree).toEqual({})
    expect(partition.activeTabTypeByWorktree).toEqual({})
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
    // Also proves the sleeping-agent fixture is well-formed, so the sweep assertions above bite.
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

  // Regression: the pane-keyed records are pruned by the worktreeId they name, not by their own key,
  // so an orphan whose ONLY residue is a sleeping agent survived -- and re-seeded the sweep on every
  // launch, so the store never self-cleared and every load scheduled another save.
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
    // On disk, not just in memory: if the flush had not persisted the cleanup, the next load would
    // silently redo it and the self-clearing assertion below would pass without meaning anything.
    const persisted = readDataFile() as PersistedState
    expect(persisted.workspaceSession.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})

    // Self-clearing: with the residue gone nothing re-seeds the orphan id, so the next launch has
    // no work. Before the fix this stayed non-empty forever and every load scheduled another save.
    const reloaded = await createStore()
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
  })

  // The session scalars are pruned by bespoke rules, not by owner key, so no owner-key loop reaches
  // them. Each has to be able to seed the sweep on its own or an orphan named only there is stuck.
  it.each([
    { label: 'activeWorktreeId', session: { activeWorktreeId: GONE_WORKTREE } },
    // Canonical `worktree:<id>` form, which needs unwrapping before the repo id is visible.
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
      workspaceSessionsByHostId: {
        [RUNTIME_HOST]: { ...getDefaultWorkspaceSession(), ...session }
      }
    })

    const store = await createStore()
    store.flush()

    const partition = store.getWorkspaceSession(RUNTIME_HOST)
    expect(partition.activeWorktreeId ?? null).toBeNull()
    expect(partition.activeWorkspaceKey ?? null).toBeNull()
    expect(partition.activeWorktreeIdsOnShutdown ?? []).toEqual([])
    const reloaded = await createStore()
    expect(reloaded.sweepDeregisteredRepoResidue()).toEqual([])
  })

  // Why: a sweep that dirtied every launch would rewrite the profile forever and mask real changes.
  it('leaves a profile with no orphans byte-identical across reloads', async () => {
    const seed = await createStore()
    seed.addRepo(makeRepo({ id: LIVE_REPO, path: '/workspace/live' }))
    seed.setWorktreeMetaForHost(LIVE_WORKTREE, 'local', { displayName: 'Live' })
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
