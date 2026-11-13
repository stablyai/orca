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
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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

  it('keeps a cross-store link whose parent repo is unknown here, and drops one with its child', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: LIVE_REPO, path: '/workspace/live' })],
      worktreeMeta: {},
      crossStoreLineageByChildKey: {
        'worktree:live-repo::/workspace/live': {
          childWorkspaceKey: 'worktree:live-repo::/workspace/live',
          childInstanceId: 'child-instance',
          parent: {
            installationId: 'other-install',
            workspaceKey: 'worktree:gone-repo::/workspace/orphan',
            instanceId: 'parent-instance'
          },
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        },
        'worktree:gone-repo::/workspace/orphan': {
          childWorkspaceKey: 'worktree:gone-repo::/workspace/orphan',
          childInstanceId: 'child-instance',
          parent: {
            installationId: 'other-install',
            workspaceKey: 'worktree:live-repo::/workspace/live',
            instanceId: 'parent-instance'
          },
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        },
        'worktree:live-repo::/workspace/unreadable': { fieldFromANewerBuild: true }
      }
    })

    const store = await createStore()
    store.flush()

    expect((readDataFile() as PersistedState).crossStoreLineageByChildKey).toEqual({
      'worktree:live-repo::/workspace/live': {
        childWorkspaceKey: 'worktree:live-repo::/workspace/live',
        childInstanceId: 'child-instance',
        parent: {
          installationId: 'other-install',
          workspaceKey: 'worktree:gone-repo::/workspace/orphan',
          instanceId: 'parent-instance'
        },
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      },
      'worktree:live-repo::/workspace/unreadable': { fieldFromANewerBuild: true }
    })
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
})
