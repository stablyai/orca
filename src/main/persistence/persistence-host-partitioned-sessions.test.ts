import { toSshExecutionHostId } from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  testState,
  createStore,
  dataFile,
  writeDataFile,
  readDataFile,
  readPersistedStateJson,
  makeRepo,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'
import { makeTerminalTab } from './persistence-session-fixtures'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { ProfileStateSqliteAuthority } from './profile-state/profile-state-sqlite-authority'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { isTerminalLeafId } from '../../shared/stable-pane-id'

import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { removeWorktreeMetaRow } from './host-qualified-worktree-meta'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store host-partitioned workspace sessions', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
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

  // Register fixture repos so orphan cleanup cannot erase host partitions on reload.
  const makeRepos = (...repoIds: string[]) => repoIds.map((id) => makeRepo({ id, path: `/${id}` }))

  it('migrates a legacy workspaceSession blob into the local partition', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('legacy-repo')
    })

    const store = await createStore()

    expect(store.getWorkspaceSession().activeRepoId).toBe('legacy-repo')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('legacy-repo')
    // Keep the legacy field readable after a downgrade.
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
      repos: makeRepos('repo-ssh'),
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
    expect(store.getSshRemotePtyLeases('ssh-1')[0]?.leafId).toBe(leafId)
  })

  it('remaps legacy SSH leases within their execution-host partition', async () => {
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: makeHostSession('local-repo'),
      repos: makeRepos('repo-a', 'repo-b'),
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

    store.setWorkspaceSession(makeHostSession('repo-a2'), 'runtime:env-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a2')
    expect(store.getWorkspaceSession('runtime:env-b').activeRepoId).toBe('repo-b')
    expect(store.getWorkspaceSession('local').activeRepoId).toBe('repo-local')
  })

  it('names the one partition each session write changed', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')
    const written: (string | null)[] = []
    store.onWorkspaceSessionWritten((hostId) => written.push(hostId))

    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a2'), 'runtime:env-a')
    store.patchWorkspaceSession({ activeTabId: 'tab-a' }, 'runtime:env-a')
    store.removeWorkspaceSessionHost('runtime:env-a')

    expect(written).toEqual(['local', 'runtime:env-a', 'runtime:env-a', 'runtime:env-a'])
  })

  it('patches a single host partition without touching the others', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-local'), 'local')
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

    store.patchWorkspaceSession({ activeTabId: 'tab-a' }, 'runtime:env-a')

    expect(store.getWorkspaceSession('runtime:env-a').activeTabId).toBe('tab-a')
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('repo-a')
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

  it('defaults an omitted hostId to the local partition', async () => {
    const store = await createStore()
    store.setWorkspaceSession(makeHostSession('repo-a'), 'runtime:env-a')

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
    store.addRepo(makeRepo({ id: 'repo-gone', path: '/repo-gone' }))
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

    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' })
    )
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
    // Unresolved ownership can park remote state locally; removal must clean that surface too.
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
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' }), {
      hostId: 'runtime:env-a'
    })

    removeWorktreeMetaRow(store, worktreeId, undefined)

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toBeUndefined()
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
    // SSH workspace state can be split between renderer-local and main’s ssh partition; clear both.
    store.setWorkspaceSession(makeSession(), 'local')
    store.setWorkspaceSession(makeSession(), 'ssh:conn-1')
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:conn-1' }), {
      hostId: 'ssh:conn-1'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:conn-1' }))

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
    // An unnecessary repo-wide fence could discard unsaved tabs in sibling worktrees.
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
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' }), {
      hostId: 'runtime:env-a'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }))

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
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'local' }), {
      hostId: 'local'
    })
    const worktreeLineage = makeWorktreeLineage({ worktreeId })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })
    store.setWorktreeLineage(
      hostWorktreeTarget({ id: worktreeId, hostId: 'local' }),
      worktreeLineage
    )
    store.setWorkspaceLineage(workspaceLineage)

    // A same-ID local metadata row must not redirect removal away from the confirmed remote host.
    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-b' }))

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
    store.setWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-b' }), {
      hostId: 'ssh:ssh-b'
    })

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'ssh:ssh-b' }))

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

    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' }))

    expect(store.getWorkspaceSession('runtime:env-a').tabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getWorkspaceSession('local').tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it("removing one SSH host's copy leaves a same-id copy on another SSH host", async () => {
    const store = await createStore()
    const worktreeId = 'repo-twin::/workspace/shared'
    const session = {
      ...makeHostSession('repo-twin'),
      tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'twin-tab', worktreeId })] }
    }
    store.setWorkspaceSession(session, toSshExecutionHostId('ssh-a'))
    store.setWorkspaceSession(session, toSshExecutionHostId('ssh-b'))

    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: worktreeId, hostId: toSshExecutionHostId('ssh-a') })
    )

    const tabsOn = (host: string) => store.getWorkspaceSession(host).tabsByWorktree[worktreeId]
    expect(tabsOn(toSshExecutionHostId('ssh-a'))).toBeUndefined()
    expect(tabsOn(toSshExecutionHostId('ssh-b'))?.[0]?.id).toBe('twin-tab')
  })

  // Fencing an unwritten host partition would rebase sibling worktrees onto empty state.
  it('does not fence a delayed session write when its host partition was never persisted', async () => {
    const store = await createStore()
    const worktreeId = 'repo-gone::/workspace/stale'
    const delayedSession = {
      ...makeHostSession('repo-gone'),
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab({ id: 'stale-tab', worktreeId })]
      }
    }

    store.removeWorkspaceSessionStateForWorktree(
      hostWorktreeTarget({ id: worktreeId, hostId: 'runtime:env-a' })
    )
    store.setWorkspaceSession(delayedSession, 'runtime:env-a')

    const session = store.getWorkspaceSession('runtime:env-a')
    expect(session.tabsByWorktree[worktreeId]?.[0]?.id).toBe('stale-tab')
    expect(session.terminalTopologyRevisionByRepoId?.['repo-gone']).toBeUndefined()
  })

  it('resets only the corrupt required field of a host partition, not the partition', async () => {
    const worktreeId = 'repo-1::/worktree'
    writeDataFile({
      schemaVersion: 1,
      repos: makeRepos('repo-1'),
      workspaceSessionsByHostId: {
        'runtime:good': makeHostSession('good-repo'),
        'runtime:bad': {
          ...makeHostSession('x'),
          activeRepoId: 123,
          tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'bad-host-tab', worktreeId })] }
        }
      }
    })

    const store = await createStore()

    expect(store.getWorkspaceSession('runtime:good').activeRepoId).toBe('good-repo')
    expect(store.getWorkspaceSession('runtime:bad').activeRepoId).toBeNull()
    expect(
      store.getWorkspaceSession('runtime:bad').tabsByWorktree[worktreeId]?.map((tab) => tab.id)
    ).toEqual(['bad-host-tab'])
  })

  it('keeps every other worktree when the local session has a corrupt required field', async () => {
    const worktreeId = 'repo-1::/worktree'
    writeDataFile({
      schemaVersion: 1,
      repos: makeRepos('repo-1'),
      workspaceSession: {
        ...makeHostSession('local-repo'),
        // A malformed scalar must not reset otherwise valid workspace tabs.
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

  // Settle unrelated migrations, then rely on the debounce to prove salvage schedules its own write.
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
    const canonical = readPersistedStateJson(dataFile())
    // Prove clean loads do not rewrite, or unrelated migration writes could mask missing salvage saves.
    const completeWrite = vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeCompleteSerializedDomains'
    )
    const selectiveWrite = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'writeSerializedDomains')
    try {
      await loadAndAwaitScheduledSave()
      expect(readPersistedStateJson(dataFile())).toBe(canonical)
      expect(completeWrite).not.toHaveBeenCalled()
      expect(selectiveWrite).not.toHaveBeenCalled()
    } finally {
      completeWrite.mockRestore()
      selectiveWrite.mockRestore()
    }
    return JSON.parse(canonical) as PersistedSessionsFile
  }

  it('schedules a save for a salvaged local session instead of re-salvaging every launch', async () => {
    const worktreeId = 'repo-1::/worktree'
    const profile = await canonicalize({
      schemaVersion: 1,
      repos: makeRepos('repo-1'),
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
      repos: makeRepos('repo-1'),
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
