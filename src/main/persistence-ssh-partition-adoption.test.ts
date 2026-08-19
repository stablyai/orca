import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeTerminalTab
} from './persistence-test-harness'
import { folderWorkspaceKey } from '../shared/workspace-scope'
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

describe('Store SSH workspace-session partition adoption', () => {
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

  it('atomically moves stranded ssh tabs into the local partition', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'repo-1::/worktree': [] }
    })
    store.setWorkspaceSession(source, 'ssh:ssh-1')

    const adopted = store.adoptSshWorkspaceSessionPartition('ssh:ssh-1')

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toEqual(
      source.tabsByWorktree['repo-1::/worktree']
    )
    expect(adopted.terminalLayoutsByTabId['tab-1']).toEqual(source.terminalLayoutsByTabId['tab-1'])
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual({})
  })

  it('finishes cleanup when an earlier move left the same tab in both partitions', async () => {
    const store = await createStore()
    const session = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession(session)
    store.setWorkspaceSession(structuredClone(session), 'ssh:ssh-1')

    const adopted = store.adoptSshWorkspaceSessionPartition('ssh:ssh-1')

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toEqual(
      session.tabsByWorktree['repo-1::/worktree']
    )
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual({})
  })

  it('keeps populated local state and preserves an equal-revision SSH fork', async () => {
    const store = await createStore()
    const local = makeBoundHostSession('ssh:ssh-1@@local-pty')
    const source = makeBoundHostSession('ssh:ssh-1@@stale-pty')
    source.tabsByWorktree['repo-1::/worktree'][0].id = 'stale-tab'
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(source, 'ssh:ssh-1')

    const adopted = store.adoptSshWorkspaceSessionPartition('ssh:ssh-1')

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toEqual(
      local.tabsByWorktree['repo-1::/worktree']
    )
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual(source.tabsByWorktree)
  })

  it('ignores non-ssh adoption requests without mutating their partition', async () => {
    const store = await createStore()
    const local = makeBoundHostSession('local-pty')
    const runtime = makeBoundHostSession('runtime:env-1@@runtime-pty')
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(runtime, 'runtime:env-1')

    const adopted = store.adoptSshWorkspaceSessionPartition('runtime:env-1')

    expect(adopted).toEqual(local)
    expect(store.getWorkspaceSession('runtime:env-1')).toEqual(runtime)
  })

  it('prunes tombstoned ssh tabs without resurrecting them locally', async () => {
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    writeDataFile({
      schemaVersion: 1,
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { 'repo-1::/worktree': [] },
        terminalSurfaceTombstonesByPaneKey: {
          [`tab-1:${TEST_LEAF_1}`]: {
            worktreeId: 'repo-1::/worktree',
            parentTabId: 'tab-1',
            leafId: TEST_LEAF_1,
            ptyId: 'ssh:ssh-1@@remote-pty',
            incarnationId: 'inc-1',
            retiredAt: 1
          }
        }
      },
      workspaceSessionsByHostId: { 'ssh:ssh-1': source }
    })
    const store = await createStore()

    const adopted = store.adoptSshWorkspaceSessionPartition('ssh:ssh-1')

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toEqual([])
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual({})
  })

  it('enumerates every persisted SSH partition including folder-only projects', async () => {
    const store = await createStore()
    const folderKey = folderWorkspaceKey('ssh-folder')
    const boundFolderSession = makeBoundHostSession('ssh:ssh-folder@@folder-pty')
    const folderSession = getDefaultWorkspaceSession()
    folderSession.tabsByWorktree = {
      [folderKey]: [
        {
          ...boundFolderSession.tabsByWorktree['repo-1::/worktree'][0],
          id: 'folder-tab',
          worktreeId: folderKey
        }
      ]
    }
    folderSession.terminalLayoutsByTabId = {
      'folder-tab': boundFolderSession.terminalLayoutsByTabId['tab-1']
    }
    folderSession.openFilesByWorktree = {
      [folderKey]: [
        {
          filePath: '/srv/folder/a.ts',
          relativePath: 'a.ts',
          worktreeId: folderKey,
          language: 'typescript'
        }
      ]
    }
    store.setWorkspaceSession(folderSession, 'ssh:ssh-folder')
    store.setWorkspaceSession(makeBoundHostSession('ssh:ssh-repo@@repo-pty'), 'ssh:ssh-repo')
    store.setWorkspaceSession(makeHostSession('runtime-repo'), 'runtime:env-a')
    const flush = vi.spyOn(store, 'flushOrThrow')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(flush).toHaveBeenCalledTimes(2)
    expect(adopted.tabsByWorktree[folderKey]).toHaveLength(1)
    expect(adopted.openFilesByWorktree?.[folderKey]?.[0]?.relativePath).toBe('a.ts')
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'runtime:env-a'])
    expect(store.getWorkspaceSession('runtime:env-a').activeRepoId).toBe('runtime-repo')
  })

  it('preserves equal-revision repo conflicts in both SSH source partitions', async () => {
    const store = await createStore()
    const left = makeBoundHostSession('ssh:left@@left-pty')
    const right = makeBoundHostSession('ssh:right@@right-pty')
    left.terminalTopologyRevisionByRepoId = { 'repo-1': 4 }
    right.terminalTopologyRevisionByRepoId = { 'repo-1': 4 }
    right.tabsByWorktree['repo-1::/worktree'][0].id = 'right-tab'
    store.setWorkspaceSession(left, 'ssh:left')
    store.setWorkspaceSession(right, 'ssh:right')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toBeUndefined()
    expect(store.getWorkspaceSession('ssh:left').tabsByWorktree).toEqual(left.tabsByWorktree)
    expect(store.getWorkspaceSession('ssh:right').tabsByWorktree).toEqual(right.tabsByWorktree)
  })

  it('preserves SSH sources whose distinct workspaces reuse one tab identity', async () => {
    const store = await createStore()
    const left = getDefaultWorkspaceSession()
    const right = getDefaultWorkspaceSession()
    left.tabsByWorktree = {
      'repo-1::/worktree': [makeTerminalTab({ id: 'shared-tab', worktreeId: 'repo-1::/worktree' })]
    }
    right.tabsByWorktree = {
      'repo-2::/worktree': [makeTerminalTab({ id: 'shared-tab', worktreeId: 'repo-2::/worktree' })]
    }
    store.setWorkspaceSession(left, 'ssh:left')
    store.setWorkspaceSession(right, 'ssh:right')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree).toEqual({})
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:left', 'ssh:right'])
    expect(store.getWorkspaceSession('ssh:left').tabsByWorktree).toEqual(left.tabsByWorktree)
    expect(store.getWorkspaceSession('ssh:right').tabsByWorktree).toEqual(right.tabsByWorktree)
  })

  it('keeps non-empty local state and unequal-revision duplicate SSH sources partitioned', async () => {
    const store = await createStore()
    const left = makeBoundHostSession('ssh:left@@left-pty')
    const right = makeBoundHostSession('ssh:right@@right-pty')
    left.terminalTopologyRevisionByRepoId = { 'repo-1': 2 }
    right.terminalTopologyRevisionByRepoId = { 'repo-1': 7 }
    right.tabsByWorktree['repo-1::/worktree'][0].id = 'right-tab'
    store.setWorkspaceSession(structuredClone(left))
    store.setWorkspaceSession(left, 'ssh:left')
    store.setWorkspaceSession(right, 'ssh:right')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toEqual(
      left.tabsByWorktree['repo-1::/worktree']
    )
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:left', 'ssh:right'])
    expect(store.getWorkspaceSession('ssh:left').tabsByWorktree).toEqual(left.tabsByWorktree)
    expect(store.getWorkspaceSession('ssh:right').tabsByWorktree).toEqual(right.tabsByWorktree)
  })

  it('does not choose a folder tab between conflicting SSH sources', async () => {
    const store = await createStore()
    const folderKey = folderWorkspaceKey('shared-folder')
    const left = makeBoundHostSession('ssh:left@@left-pty')
    const right = makeBoundHostSession('ssh:right@@right-pty')
    left.tabsByWorktree = {
      [folderKey]: [{ ...left.tabsByWorktree['repo-1::/worktree'][0], worktreeId: folderKey }]
    }
    right.tabsByWorktree = {
      [folderKey]: [
        {
          ...right.tabsByWorktree['repo-1::/worktree'][0],
          id: 'right-tab',
          worktreeId: folderKey
        }
      ]
    }
    store.setWorkspaceSession(left, 'ssh:left')
    store.setWorkspaceSession(right, 'ssh:right')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree[folderKey]).toBeUndefined()
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:left', 'ssh:right'])
  })

  it('prunes only the source whose state reconciled without ambiguity', async () => {
    const store = await createStore()
    const folderKey = folderWorkspaceKey('ambiguous-folder')
    const local = getDefaultWorkspaceSession()
    local.tabsByWorktree[folderKey] = [
      makeTerminalTab({ id: 'local-folder-tab', worktreeId: folderKey })
    ]
    const accepted = makeBoundHostSession('ssh:accepted@@accepted-pty')
    const retained = getDefaultWorkspaceSession()
    retained.tabsByWorktree = {
      [folderKey]: [makeTerminalTab({ id: 'remote-folder-tab', worktreeId: folderKey })]
    }
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(accepted, 'ssh:accepted')
    store.setWorkspaceSession(retained, 'ssh:retained')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toHaveLength(1)
    expect(adopted.tabsByWorktree[folderKey]?.[0]?.id).toBe('local-folder-tab')
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:retained'])
  })

  it('scopes a qualified adoption request to exactly one SSH partition', async () => {
    const store = await createStore()
    const left = makeBoundHostSession('ssh:left@@left-pty')
    const right = makeBoundHostSession('ssh:right@@right-pty')
    right.tabsByWorktree = {
      'repo-2::/worktree': [makeTerminalTab({ id: 'right-tab', worktreeId: 'repo-2::/worktree' })]
    }
    store.setWorkspaceSession(left, 'ssh:left')
    store.setWorkspaceSession(right, 'ssh:right')

    const adopted = store.adoptSshWorkspaceSessionPartition('ssh:left')

    expect(adopted.tabsByWorktree['repo-1::/worktree']).toHaveLength(1)
    expect(adopted.tabsByWorktree['repo-2::/worktree']).toBeUndefined()
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:right'])
  })

  it('rejects adoption before mutation when persistence writes are frozen', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession(source, 'ssh:ssh-1')
    store.flushOrThrow()
    store.freezeWrites()

    expect(() => store.adoptSshWorkspaceSessionPartition()).toThrow('writes are frozen')
    expect(store.getWorkspaceSession().tabsByWorktree).toEqual({})
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual(source.tabsByWorktree)
  })

  it('rolls back owner and sources when the durable owner flush fails', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession(getDefaultWorkspaceSession())
    store.setWorkspaceSession(source, 'ssh:ssh-1')
    const flush = vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('owner flush failed')
    })

    expect(() => store.adoptSshWorkspaceSessionPartition()).toThrow('owner flush failed')
    flush.mockRestore()

    expect(store.getWorkspaceSession().tabsByWorktree).toEqual({})
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual(source.tabsByWorktree)
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local', 'ssh:ssh-1'])
  })

  it('keeps the durable owner and retryable sources when source pruning fails', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession(getDefaultWorkspaceSession())
    store.setWorkspaceSession(source, 'ssh:ssh-1')
    const durableFlush = store.flushOrThrow.bind(store)
    const flush = vi
      .spyOn(store, 'flushOrThrow')
      .mockImplementationOnce(durableFlush)
      .mockImplementationOnce(() => {
        throw new Error('source prune failed')
      })

    expect(() => store.adoptSshWorkspaceSessionPartition()).toThrow('source prune failed')
    flush.mockRestore()

    expect(store.getWorkspaceSession().tabsByWorktree['repo-1::/worktree']).toHaveLength(1)
    expect(store.getWorkspaceSession('ssh:ssh-1').tabsByWorktree).toEqual(source.tabsByWorktree)
    const persisted = readDataFile() as PersistedState
    expect(persisted.workspaceSession.tabsByWorktree['repo-1::/worktree']).toHaveLength(1)
    expect(persisted.workspaceSessionsByHostId?.['ssh:ssh-1']?.tabsByWorktree).toEqual(
      source.tabsByWorktree
    )
  })

  it('converges idempotently when retrying after a source-prune failure', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    store.setWorkspaceSession(getDefaultWorkspaceSession())
    store.setWorkspaceSession(source, 'ssh:ssh-1')
    const durableFlush = store.flushOrThrow.bind(store)
    const flush = vi
      .spyOn(store, 'flushOrThrow')
      .mockImplementationOnce(durableFlush)
      .mockImplementationOnce(() => {
        throw new Error('source prune failed')
      })
    expect(() => store.adoptSshWorkspaceSessionPartition()).toThrow('source prune failed')
    flush.mockRestore()
    const beforeRetry = structuredClone(store.getWorkspaceSession())

    const afterRetry = store.adoptSshWorkspaceSessionPartition()

    expect(afterRetry).toEqual(beforeRetry)
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
    const reloaded = await createStore()
    expect(reloaded.getWorkspaceSession().tabsByWorktree).toEqual(beforeRetry.tabsByWorktree)
    expect(reloaded.getWorkspaceSession().terminalLayoutsByTabId).toEqual(
      beforeRetry.terminalLayoutsByTabId
    )
    expect(reloaded.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  it('reconciles a newer SSH binding, incarnation, and sleeping provider identity', async () => {
    const store = await createStore()
    const local = makeBoundHostSession('ssh:ssh-1@@old-pty')
    local.terminalPtyIncarnationsByPaneKey = { [`tab-1:${TEST_LEAF_1}`]: 'inc-old' }
    local.sleepingAgentSessionsByPaneKey = {
      [`tab-1:${TEST_LEAF_1}`]: {
        paneKey: `tab-1:${TEST_LEAF_1}`,
        tabId: 'tab-1',
        worktreeId: 'repo-1::/worktree',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-old' },
        prompt: 'old',
        state: 'working',
        capturedAt: 9,
        updatedAt: 9
      }
    }
    const source = makeBoundHostSession('ssh:ssh-1@@new-pty')
    source.terminalTopologyRevisionByRepoId = { 'repo-1': 1 }
    source.terminalPtyIncarnationsByPaneKey = { [`tab-1:${TEST_LEAF_1}`]: 'inc-new' }
    source.sleepingAgentSessionsByPaneKey = {
      [`tab-1:${TEST_LEAF_1}`]: {
        ...local.sleepingAgentSessionsByPaneKey[`tab-1:${TEST_LEAF_1}`],
        providerSession: { key: 'session_id', id: 'provider-new' },
        prompt: 'new',
        capturedAt: 1,
        updatedAt: 1
      }
    }
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(source, 'ssh:ssh-1')

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.tabsByWorktree['repo-1::/worktree']?.[0]?.ptyId).toBe('ssh:ssh-1@@new-pty')
    expect(adopted.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[TEST_LEAF_1]).toBe(
      'ssh:ssh-1@@new-pty'
    )
    expect(adopted.terminalPtyIncarnationsByPaneKey?.[`tab-1:${TEST_LEAF_1}`]).toBe('inc-new')
    expect(
      adopted.sleepingAgentSessionsByPaneKey?.[`tab-1:${TEST_LEAF_1}`]?.providerSession.id
    ).toBe('provider-new')
  })

  it('preserves a sync-flushed SSH incarnation across the adoption crash window', async () => {
    const store = await createStore()
    const local = makeBoundHostSession('ssh:ssh-1@@old-pty')
    local.terminalPtyIncarnationsByPaneKey = { [`tab-1:${TEST_LEAF_1}`]: 'inc-old' }
    const source = structuredClone(local)
    store.setWorkspaceSession(local)
    store.setWorkspaceSession(source, 'ssh:ssh-1')
    expect(
      store.persistPtyBinding(
        {
          worktreeId: 'repo-1::/worktree',
          tabId: 'tab-1',
          leafId: TEST_LEAF_1,
          ptyId: 'ssh:ssh-1@@new-pty',
          incarnationId: 'inc-new',
          expectedBinding: { ptyId: 'ssh:ssh-1@@old-pty', incarnationId: 'inc-old' }
        },
        'ssh:ssh-1'
      )
    ).toBe(true)

    const adopted = store.adoptSshWorkspaceSessionPartition()

    expect(adopted.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[TEST_LEAF_1]).toBe(
      'ssh:ssh-1@@new-pty'
    )
    expect(adopted.terminalPtyIncarnationsByPaneKey?.[`tab-1:${TEST_LEAF_1}`]).toBe('inc-new')
    expect(adopted.terminalTopologyRevisionByRepoId?.['repo-1']).toBe(1)
  })

  it('removes all SSH source metadata only after the owner is durable', async () => {
    const store = await createStore()
    const source = makeBoundHostSession('ssh:ssh-1@@remote-pty')
    source.terminalPtyIncarnationsByPaneKey = { [`tab-1:${TEST_LEAF_1}`]: 'inc-1' }
    source.terminalTopologyRevisionByRepoId = { 'repo-1': 3 }
    source.tabGroups = {
      'repo-1::/worktree': [
        {
          id: 'group-1',
          worktreeId: 'repo-1::/worktree',
          activeTabId: 'tab-1',
          tabOrder: ['tab-1']
        }
      ]
    }
    store.setWorkspaceSession(source, 'ssh:ssh-1')

    store.adoptSshWorkspaceSessionPartition()

    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])
    const persisted = readDataFile() as PersistedState
    expect(persisted.workspaceSessionsByHostId?.['ssh:ssh-1']).toBeUndefined()
    expect(persisted.workspaceSession.terminalPtyIncarnationsByPaneKey).toEqual({
      [`tab-1:${TEST_LEAF_1}`]: 'inc-1'
    })
    expect(persisted.workspaceSession.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 3 })
    expect(persisted.workspaceSession.tabGroups?.['repo-1::/worktree']?.[0]?.id).toBe('group-1')
  })
})
