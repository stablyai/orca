import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { isTerminalLeafId } from '../shared/stable-pane-id'
import {
  testState,
  createStore,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store host-partitioned workspace sessions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const makeHostSession = (activeRepoId: string): WorkspaceSessionState => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId
  })

  const makeLegacyPaneHostSession = (repoId: string, ptyId: string): WorkspaceSessionState => {
    const worktreeId = `${repoId}::/worktree`
    return {
      ...getDefaultWorkspaceSession(),
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-shared',
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'tab-shared', worktreeId, ptyId })]
      },
      terminalLayoutsByTabId: {
        'tab-shared': {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': ptyId }
        }
      }
    }
  }

  const makeBoundHostSession = (ptyId: string | null): WorkspaceSessionState => ({
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::/worktree',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'repo-1::/worktree': [
        {
          id: 'tab-1',
          worktreeId: 'repo-1::/worktree',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: ptyId ? { [TEST_LEAF_1]: ptyId } : {}
      }
    }
  })

  it('migrates a legacy workspaceSession blob into the local partition', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('legacy-repo')
    })

    const store = await createStore()

    // The legacy blob is the 'local' partition; an explicit/default hostId reads it.
    expect(store.getWorkspaceSession().activeRepoId).toBe('legacy-repo')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('legacy-repo')
    // No data was moved, so a downgrade still finds the legacy field intact.
    store.flush()
    const persisted = readDataFile() as { workspaceSession?: { activeRepoId?: string } }
    expect(persisted.workspaceSession?.activeRepoId).toBe('legacy-repo')
  })

  it('is idempotent: re-loading already-partitioned state preserves all hosts', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      workspaceSessionsByHostId: {
        'runtime:env-a': makeHostSession('runtime-repo'),
        'ssh:host-b': makeHostSession('ssh-repo')
      }
    })

    const readSessionPartitions = (): unknown => {
      const data = readDataFile() as {
        workspaceSession?: unknown
        workspaceSessionsByHostId?: unknown
      }
      return {
        workspaceSession: data.workspaceSession,
        workspaceSessionsByHostId: data.workspaceSessionsByHostId
      }
    }

    const first = await createStore()
    first.flush()
    const afterFirst = readSessionPartitions()

    const second = await createStore()
    second.flush()
    const afterSecond = readSessionPartitions()

    // Re-running the partition migration must not move or reshape any host.
    expect(afterSecond).toEqual(afterFirst)
    expect(second.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('runtime-repo')
    expect(second.getWorkspaceSession('ssh:host-b').activeRepoId).toBe('ssh-repo')
    expect(second.getWorkspaceSession('local').activeRepoId).toBe('local-repo')
  })

  it('drops a stray "local" key in workspaceSessionsByHostId in favor of the legacy blob', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('canonical-local'),
      workspaceSessionsByHostId: {
        local: makeHostSession('shadow-local')
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('local').activeRepoId).toBe('canonical-local')
  })

  it('rewrites legacy pane ids inside a host partition and remaps its leases', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      workspaceSessionsByHostId: {
        'ssh:ssh-1': makeLegacyPaneHostSession('repo-ssh', 'remote-pty')
      },
      sshRemotePtyLeases: [
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty',
          worktreeId: 'repo-ssh::/worktree',
          tabId: 'tab-shared',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()

    const root = store.getWorkspaceSession('ssh:ssh-1').terminalLayoutsByTabId['tab-shared']?.root
    const leafId = root?.type === 'leaf' ? root.leafId : null
    expect(leafId && isTerminalLeafId(leafId)).toBe(true)
    // The lease follows the partition's rewritten leaf, not the legacy `pane:1`.
    expect(store.getSshRemotePtyLeases('ssh-1')[0]?.leafId).toBe(leafId)
  })

  it('remaps legacy SSH leases within their execution-host partition', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      workspaceSessionsByHostId: {
        'ssh:host-a': makeLegacyPaneHostSession('repo-a', 'pty-a'),
        'ssh:host-b': makeLegacyPaneHostSession('repo-b', 'pty-b')
      },
      sshRemotePtyLeases: [
        {
          targetId: 'host-a',
          ptyId: 'pty-a',
          worktreeId: 'repo-a::/worktree',
          tabId: 'tab-shared',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        },
        {
          targetId: 'host-b',
          ptyId: 'pty-b',
          worktreeId: 'repo-b::/worktree',
          tabId: 'tab-shared',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const rootA = store.getWorkspaceSession('ssh:host-a').terminalLayoutsByTabId['tab-shared']?.root
    const rootB = store.getWorkspaceSession('ssh:host-b').terminalLayoutsByTabId['tab-shared']?.root
    const leafA = rootA?.type === 'leaf' ? rootA.leafId : null
    const leafB = rootB?.type === 'leaf' ? rootB.leafId : null

    expect(leafA && isTerminalLeafId(leafA)).toBe(true)
    expect(leafB && isTerminalLeafId(leafB)).toBe(true)
    expect(leafA).not.toBe(leafB)
    expect(store.getSshRemotePtyLeases('host-a')[0]?.leafId).toBe(leafA)
    expect(store.getSshRemotePtyLeases('host-b')[0]?.leafId).toBe(leafB)
  })

  it('repairs a stable SSH lease leaf copied from another host partition', async () => {
    const leafA = '11111111-1111-4111-8111-111111111111'
    const leafB = '22222222-2222-4222-8222-222222222222'
    const makeStableHostSession = (
      repoId: string,
      ptyId: string,
      leafId: string
    ): WorkspaceSessionState => {
      const worktreeId = `${repoId}::/worktree`
      return {
        ...getDefaultWorkspaceSession(),
        activeRepoId: repoId,
        activeWorktreeId: worktreeId,
        activeTabId: 'tab-shared',
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'tab-shared', worktreeId, ptyId })]
        },
        terminalLayoutsByTabId: {
          'tab-shared': {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: ptyId }
          }
        }
      }
    }
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      workspaceSessionsByHostId: {
        'ssh:host-a': makeStableHostSession('repo-a', 'pty-a', leafA),
        'ssh:host-b': makeStableHostSession('repo-b', 'pty-b', leafB)
      },
      sshRemotePtyLeases: [
        {
          targetId: 'host-b',
          ptyId: 'pty-b',
          worktreeId: 'repo-b::/worktree',
          tabId: 'tab-shared',
          leafId: leafA,
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()

    expect(store.getSshRemotePtyLeases('host-b')[0]?.leafId).toBe(leafB)
  })

  it('isolates writes: setting host A does not mutate host B or local', async () => {
    const store = await createStore()

    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')
    store.setWorkspaceSession(makeHostSession('repo-b'), 'runtime:env-b')

    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
    expect(store.getWorkspaceSession('runtime:env-b').activeRepoId).toBe('repo-b')

    // Overwriting host A leaves host B and local untouched.
    store.setWorkspaceSession(makeHostSession('repo-a2'), 'runtime:env-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a2')
    expect(store.getWorkspaceSession('runtime:env-b').activeRepoId).toBe('repo-b')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
  })

  it('patches a single host partition without touching the others', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

    store.patchWorkspaceSession({ activeTabId: 'tab-a' }, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').activeTabId).toBe('tab-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
    // Local was never given that tab id.
    expect(store.getWorkspaceSession('local').activeTabId).toBeNull()
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
  })

  it('preserves and enforces equal repo-id topology authority independently per host', async () => {
    const store = await createStore()
    const worktreeId = 'duplicate::/worktree'
    const staleTabs = {
      [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId, ptyId: 'stale-pty' })]
    }
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { duplicate: 2 }
      },
      'runtime:env-a'
    )
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'live-tab', worktreeId, ptyId: 'live-pty' })]
        },
        terminalTopologyRevisionByRepoId: { duplicate: 7 }
      },
      'runtime:env-b'
    )

    store.setWorkspaceSession(
      { ...getDefaultWorkspaceSession(), tabsByWorktree: staleTabs },
      'runtime:env-a'
    )
    store.patchWorkspaceSession({ tabsByWorktree: staleTabs }, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toEqual([])
    expect(
      store.getWorkspaceSession('runtime:env-a').terminalTopologyRevisionByRepoId?.duplicate
    ).toBe(2)
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]?.[0]?.id).toBe(
      'live-tab'
    )
    expect(
      store.getWorkspaceSession('runtime:env-b').terminalTopologyRevisionByRepoId?.duplicate
    ).toBe(7)
  })

  it('persists an SSH PTY binding only in the SSH host partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeBoundHostSession(null), 'local')
    store.setWorkspaceSession(makeBoundHostSession(null), 'ssh:ssh-1')

    store.persistPtyBinding(
      {
        worktreeId: 'repo-1::/worktree',
        tabId: 'tab-1',
        leafId: TEST_LEAF_1,
        ptyId: 'ssh:ssh-1@@remote-pty'
      },
      'ssh:ssh-1'
    )

    expect(
      store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBe('ssh:ssh-1@@remote-pty')
    expect(
      store.getWorkspaceSession('local').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
  })

  it('rolls back a failed SSH PTY binding flush in the SSH host partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeBoundHostSession(null), 'local')
    store.setWorkspaceSession(makeBoundHostSession(null), 'ssh:ssh-1')
    const flush = vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })

    expect(() =>
      store.persistPtyBinding(
        {
          worktreeId: 'repo-1::/worktree',
          tabId: 'tab-1',
          leafId: TEST_LEAF_1,
          ptyId: 'ssh:ssh-1@@remote-pty'
        },
        'ssh:ssh-1'
      )
    ).toThrow('disk unavailable')
    flush.mockRestore()

    expect(
      store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
    expect(
      store.getWorkspaceSession('local').tabsByWorktree['repo-1::/worktree'][0]?.ptyId
    ).toBeNull()
  })

  it('clears expired SSH PTY bindings from the SSH partition and legacy local copy', async () => {
    const store = await createStore()
    const ptyId = 'ssh:ssh-1@@remote-pty'
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'local')
    store.setWorkspaceSession(makeBoundHostSession(ptyId), 'ssh:ssh-1')
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'repo-1::/worktree',
      tabId: 'tab-1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })

    store.markSshRemotePtyLease('ssh-1', ptyId, 'expired')

    for (const hostId of ['local', 'ssh:ssh-1']) {
      const session = store.getWorkspaceSession(hostId)
      expect(session.tabsByWorktree['repo-1::/worktree'][0]?.ptyId).toBeNull()
      expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({})
    }
  })

  it('defaults an omitted hostId to the local partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

    // No hostId → local, which is still empty/default and unaffected by host A.
    store.setWorkspaceSession(makeHostSession('repo-local'))
    expect(store.getWorkspaceSession().activeRepoId).toBe('repo-local')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
  })

  it('round-trips host partitions through disk', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
  })

  it('removes one orphaned worktree with a host-scoped topology fence', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const session = {
      ...makeHostSession('repo-gone'),
      activeWorktreeId: worktreeId,
      activeWorktreeIdsOnShutdown: [worktreeId],
      lastVisitedAtByWorktreeId: { [worktreeId]: 123 },
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      },
      terminalTopologyRevisionByRepoId: { 'repo-gone': 3 }
    }
    store.setWorkspaceSession(session, 'local')
    store.setWorkspaceSession(session, 'runtime:env-a')
    store.setWorkspaceSession(session, 'runtime:env-b')

    store.removeWorkspaceSessionStateForWorktree(worktreeId, 'runtime:env-a')
    store.setWorkspaceSession(session, 'runtime:env-a')
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession('runtime:env-a')).toMatchObject({
      tabsByWorktree: {},
      terminalTopologyRevisionByRepoId: { 'repo-gone': 4 }
    })
    expect(reloaded.getWorkspaceSession('runtime:env-b')).toMatchObject({
      activeWorktreeId: worktreeId,
      activeWorktreeIdsOnShutdown: [worktreeId],
      lastVisitedAtByWorktreeId: { [worktreeId]: 123 },
      terminalTopologyRevisionByRepoId: { 'repo-gone': 3 }
    })
    // The local blob is a co-owner surface for every remote host, since the renderer parks state
    // there whenever worktree ownership is unresolved; leaving it behind leaks the removed worktree.
    expect(reloaded.getWorkspaceSession('local')).toMatchObject({
      tabsByWorktree: {},
      activeWorktreeId: null,
      activeWorktreeIdsOnShutdown: [],
      lastVisitedAtByWorktreeId: {},
      terminalTopologyRevisionByRepoId: { 'repo-gone': 4 }
    })
  })

  it('uses persisted worktree ownership when removing metadata', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const session = {
      ...makeHostSession('repo-gone'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(session, 'local')
    store.setWorkspaceSession(session, 'runtime:env-a')
    store.setWorkspaceSession(session, 'runtime:env-b')
    store.setWorktreeMeta(worktreeId, { hostId: 'runtime:env-a' })

    store.removeWorktreeMeta(worktreeId)

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toBeUndefined()
    // Only the owning host's partition and the local blob it may spill into are cleaned; a same-id
    // worktree on another host is a different workspace and must survive.
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('cleans both surfaces that hold an ssh-owned worktree', async () => {
    const store = await createStore()
    const worktreeId = 'repo-ssh::/srv/stale'
    const makeSession = (): ReturnType<typeof makeHostSession> => ({
      ...makeHostSession('repo-ssh'),
      activeWorktreeId: worktreeId,
      lastVisitedAtByWorktreeId: { [worktreeId]: 123 },
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    })
    // The renderer persists SSH workspaces in the local blob; the main process writes their
    // terminal state to the host's own `ssh:*` partition. Removal must clear both.
    store.setWorkspaceSession(makeSession(), 'local')
    store.setWorkspaceSession(makeSession(), 'ssh:conn-1')
    store.setWorktreeMeta(worktreeId, { hostId: 'ssh:conn-1' })

    store.removeWorktreeMeta(worktreeId, 'ssh:conn-1')

    for (const hostId of ['local', 'ssh:conn-1'] as const) {
      expect(store.getWorkspaceSession(hostId)).toMatchObject({
        tabsByWorktree: {},
        activeWorktreeId: null,
        lastVisitedAtByWorktreeId: {},
        terminalTopologyRevisionByRepoId: { 'repo-ssh': 1 }
      })
    }
  })

  it('does not bump the topology fence in a partition that never held the worktree', async () => {
    const store = await createStore()
    const worktreeId = 'repo-split::/workspace/stale'
    const otherWorktreeId = 'repo-split::/workspace/live'
    // Why this matters: the fence is keyed by repo, so a bump here would make every later write
    // for repo-split rebase onto main's copy and silently drop the live worktree's unsaved tabs.
    store.setWorkspaceSession(
      {
        ...makeHostSession('repo-split'),
        tabsByWorktree: {
          [otherWorktreeId]: [makeTerminalTab({ id: 'live-tab', worktreeId: otherWorktreeId })]
        }
      },
      'local'
    )
    store.setWorkspaceSession(
      {
        ...makeHostSession('repo-split'),
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
        }
      },
      'runtime:env-a'
    )
    store.setWorktreeMeta(worktreeId, { hostId: 'runtime:env-a' })

    store.removeWorktreeMeta(worktreeId, 'local')

    expect(
      store.getWorkspaceSession('runtime:env-a').terminalTopologyRevisionByRepoId?.['repo-split']
    ).toBeUndefined()
    expect(
      store.getWorkspaceSession('local').terminalTopologyRevisionByRepoId?.['repo-split']
    ).toBeUndefined()
    expect(store.getWorkspaceSession('local').tabsByWorktree[otherWorktreeId]).toHaveLength(1)
    expect(store.getWorktreeMeta(worktreeId)?.hostId).toBe('runtime:env-a')
  })

  it('preserves a same-id persisted owner when another qualified host is removed', async () => {
    const store = await createStore()
    const worktreeId = 'repo-split::/workspace/stale'
    const session = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(session, 'local')
    store.setWorkspaceSession(session, 'runtime:env-b')
    store.setWorktreeMeta(worktreeId, { hostId: 'local' })
    const worktreeLineage = makeWorktreeLineage({ worktreeId })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })
    store.setWorktreeLineage(worktreeId, worktreeLineage)
    store.setWorkspaceLineage(workspaceLineage)

    // The confirmed removal target is env-b. Bare metadata belongs to the same-id
    // local owner and must not redirect the post-delete purge back to local.
    store.removeWorktreeMeta(worktreeId, 'runtime:env-b')

    expect(store.getWorktreeMeta(worktreeId)?.hostId).toBe('local')
    expect(store.getWorktreeLineage(worktreeId)).toEqual(worktreeLineage)
    expect(store.getWorkspaceLineage(workspaceLineage.childWorkspaceKey)).toEqual(workspaceLineage)
    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(store.getWorkspaceSession('runtime:env-b').tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('preserves a surviving local session when removed-host metadata owns the shared id', async () => {
    const store = await createStore()
    const worktreeId = 'repo-split::/workspace/stale'
    store.addRepo(makeRepo({ id: 'repo-split', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'repo-split',
        path: '/remote/repo',
        connectionId: 'ssh-b',
        executionHostId: 'ssh:ssh-b'
      })
    )
    const localSession = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'same-id-local-tab', worktreeId })]
      }
    }
    const remoteSession = {
      ...makeHostSession('repo-split'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'removed-remote-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(localSession, 'local')
    store.setWorkspaceSession(remoteSession, 'ssh:ssh-b')
    store.setWorktreeMeta(worktreeId, { hostId: 'ssh:ssh-b' })

    store.removeWorktreeMeta(worktreeId, 'ssh:ssh-b')

    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'same-id-local-tab' })
    ])
    expect(store.getWorkspaceSession('ssh:ssh-b').tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getWorktreeMeta(worktreeId)).toBeUndefined()
  })

  it('falls back to the caller hostId only when no ownership was recorded', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const session = {
      ...makeHostSession('repo-gone'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }
    store.setWorkspaceSession(session, 'runtime:env-a')
    store.setWorkspaceSession(session, 'local')

    store.removeWorktreeMeta(worktreeId, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toBeUndefined()
  })

  // Trade-off: the fence is repo-wide, so claiming authority over a partition main never wrote would
  // rebase every sibling worktree of that repo onto an empty copy. A delayed write wins here instead.
  it('does not fence a delayed session write when its host partition was never persisted', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const delayedSession = {
      ...makeHostSession('repo-gone'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }

    store.removeWorkspaceSessionStateForWorktree(worktreeId, 'runtime:env-a')
    store.setWorkspaceSession(delayedSession, 'runtime:env-a')

    const session = store.getWorkspaceSession('runtime:env-a')
    expect(session.tabsByWorktree[worktreeId]?.[0]?.id).toBe('stale-tab')
    expect(session.terminalTopologyRevisionByRepoId?.['repo-gone']).toBeUndefined()
  })

  it('resets only the corrupt required field of a host partition, not the partition', async () => {
    const worktreeId = 'repo-1::/worktree'
    writeDataFile({
      schemaVersion: 1,
      workspaceSessionsByHostId: {
        'runtime:good': makeHostSession('good-repo'),
        // activeRepoId must be string|null; a number fails the zod parse.
        'runtime:bad': {
          ...makeHostSession('x'),
          activeRepoId: 123,
          tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'bad-host-tab', worktreeId })] }
        }
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('runtime:good').activeRepoId).toBe('good-repo')
    // The unsalvageable field falls back to its default; the partition's tabs survive.
    expect(store.getWorkspaceSession('runtime:bad').activeRepoId).toBeNull()
    expect(
      store.getWorkspaceSession('runtime:bad').tabsByWorktree[worktreeId]?.map((tab) => tab.id)
    ).toEqual(['bad-host-tab'])
  })

  it('keeps every other worktree when the local session has a corrupt required field', async () => {
    const worktreeId = 'repo-1::/worktree'
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: {
        ...makeHostSession('local-repo'),
        // A projected/truncated write can leave a top-level field the wrong type;
        // that must not cost every worktree's tabs the way a full reset did.
        activeTabId: 42,
        tabsByWorktree: {
          [worktreeId]: [makeTerminalTab({ id: 'local-keep', worktreeId })]
        }
      }
    })

    const store = await createStore()

    const session = store.getWorkspaceSession('local')
    expect(session.activeTabId).toBeNull()
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual(['local-keep'])
  })

  type PersistedSessionsFile = {
    workspaceSession?: {
      tabsByWorktree?: Record<string, { id: string }[]>
      sleepingAgentSessionsByPaneKey?: Record<string, unknown>
    }
    workspaceSessionsByHostId?: Record<
      string,
      { tabsByWorktree?: Record<string, { id: string }[]> }
    >
  }

  // Why: flush() writes whatever the state hash says is dirty, so it passes even
  // when nothing scheduled a save — it cannot see the repair write at all. Loading
  // once first canonicalizes the profile (a second load of a canonical file
  // schedules nothing), so a later rewrite proves the salvage scheduled it.
  async function loadAndAwaitScheduledSave(): Promise<void> {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      vi.advanceTimersByTime(10_000)
      await store.waitForPendingWrite()
    } finally {
      vi.useRealTimers()
    }
  }

  async function canonicalize(fixture: Record<string, unknown>): Promise<PersistedSessionsFile> {
    writeDataFile(fixture)
    await loadAndAwaitScheduledSave()
    const canonical = readFileSync(dataFile(), 'utf-8')
    // Why: the save assertions below are only meaningful if a clean load schedules
    // nothing. Prove that here rather than assume it — a future migration that
    // dirtied every load would otherwise leave those tests silently vacuous.
    await loadAndAwaitScheduledSave()
    expect(readFileSync(dataFile(), 'utf-8')).toBe(canonical)
    return JSON.parse(canonical) as PersistedSessionsFile
  }

  it('schedules a save for a salvaged local session instead of re-salvaging every launch', async () => {
    const worktreeId = 'repo-1::/worktree'
    const profile = await canonicalize({
      schemaVersion: 1,
      workspaceSession: {
        ...makeHostSession('local-repo'),
        tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'tab-keep', worktreeId })] }
      }
    })
    const tabs = profile.workspaceSession?.tabsByWorktree?.[worktreeId]
    expect(tabs).toBeDefined()
    tabs!.push({ id: 'tab-corrupt' })
    writeDataFile(profile)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadAndAwaitScheduledSave()
      expect(warn).toHaveBeenCalledWith(
        '[persistence] Salvaged workspace session; dropped corrupt entries:',
        { count: 1, fields: ['tabsByWorktree'], detailsTruncated: false }
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain(worktreeId)
    } finally {
      warn.mockRestore()
    }

    const persisted = readDataFile() as PersistedSessionsFile
    expect(persisted.workspaceSession?.tabsByWorktree?.[worktreeId]?.map((tab) => tab.id)).toEqual([
      'tab-keep'
    ])
  })

  it('schedules a save for salvaged host partitions', async () => {
    const worktreeId = 'repo-1::/worktree'
    const profile = await canonicalize({
      schemaVersion: 1,
      workspaceSessionsByHostId: {
        'runtime:env-a': {
          ...makeHostSession('runtime-repo'),
          tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'runtime-keep', worktreeId })] }
        },
        'ssh:target-b': {
          ...makeHostSession('ssh-repo'),
          tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'ssh-keep', worktreeId })] }
        }
      }
    })
    const partitions = profile.workspaceSessionsByHostId
    const runtimeTabs = partitions?.['runtime:env-a']?.tabsByWorktree?.[worktreeId]
    const sshTabs = partitions?.['ssh:target-b']?.tabsByWorktree?.[worktreeId]
    expect(runtimeTabs).toBeDefined()
    expect(sshTabs).toBeDefined()
    runtimeTabs!.push({ id: 'runtime-corrupt' })
    sshTabs!.push({ id: 'ssh-corrupt' })
    const mutablePartitions = partitions as Record<string, unknown>
    mutablePartitions['runtime:broken'] = 'not a session'
    writeDataFile(profile)
    await loadAndAwaitScheduledSave()

    const persisted = (readDataFile() as PersistedSessionsFile).workspaceSessionsByHostId
    expect(
      persisted?.['runtime:env-a']?.tabsByWorktree?.[worktreeId]?.map((tab) => tab.id)
    ).toEqual(['runtime-keep'])
    expect(persisted?.['ssh:target-b']?.tabsByWorktree?.[worktreeId]?.map((tab) => tab.id)).toEqual(
      ['ssh-keep']
    )
    expect(persisted).not.toHaveProperty('runtime:broken')
  })

  it('writes back sleeping-agent records dropped during salvage', async () => {
    const profile = await canonicalize({
      schemaVersion: 1,
      workspaceSession: {
        ...makeHostSession('local-repo'),
        sleepingAgentSessionsByPaneKey: {}
      }
    })
    profile.workspaceSession!.sleepingAgentSessionsByPaneKey = {
      'tab-bad:leaf': { paneKey: 'different:leaf' }
    }
    writeDataFile(profile)

    await loadAndAwaitScheduledSave()

    const persisted = readDataFile() as PersistedSessionsFile
    expect(persisted.workspaceSession?.sleepingAgentSessionsByPaneKey).toBeUndefined()
  })
})
