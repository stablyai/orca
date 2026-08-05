import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import type { TerminalTab, WorkspaceSessionState } from '../shared/types'

const testState = { dir: '' }
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const APP_PTY_ID = 'ssh:target-1@@pty-old'
const SSH_HOST_ID = 'ssh:target-1'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  }
}))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

async function createStore() {
  vi.resetModules()
  const { Store } = await import('./persistence')
  return new Store({ dataFile: join(testState.dir, 'orca-data.json') })
}

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ptyId: 'pty-old',
    ...overrides
  }
}

function sessionWithExistingPane(ptyId = 'pty-old'): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { 'wt-1': [terminalTab({ ptyId })] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: ptyId }
      }
    },
    terminalTopologyRevisionByRepoId: { 'wt-1': 7 }
  }
}

describe('Store SSH reattach containment', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-ssh-reattach-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses every creating bind branch without mutation or flush', async () => {
    const store = await createStore()
    const cases: {
      name: string
      session: WorkspaceSessionState
      tabId: string
      leafId: string
    }[] = [
      {
        name: 'missing tab',
        session: getDefaultWorkspaceSession(),
        tabId: 'tab-missing',
        leafId: LEAF_1
      },
      {
        name: 'missing legacy tab',
        session: getDefaultWorkspaceSession(),
        tabId: 'tab-missing',
        leafId: 'pane:legacy'
      },
      {
        name: 'missing layout',
        session: {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { 'wt-1': [terminalTab()] }
        },
        tabId: 'tab-1',
        leafId: LEAF_1
      },
      {
        name: 'empty layout root',
        session: {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { 'wt-1': [terminalTab()] },
          terminalLayoutsByTabId: {
            'tab-1': {
              root: null,
              activeLeafId: null,
              expandedLeafId: null,
              ptyIdsByLeafId: {}
            }
          }
        },
        tabId: 'tab-1',
        leafId: LEAF_1
      },
      {
        name: 'missing leaf',
        session: sessionWithExistingPane(),
        tabId: 'tab-1',
        leafId: LEAF_2
      }
    ]
    const flush = vi.spyOn(store, 'flushOrThrow')

    for (const [optionIndex, options] of [{ mayCreate: false }].entries()) {
      for (const [caseIndex, testCase] of cases.entries()) {
        const hostId = `ssh:test-${optionIndex}-${caseIndex}`
        store.setWorkspaceSession(structuredClone(testCase.session), hostId)
        const before = structuredClone(store.getWorkspaceSession(hostId))
        flush.mockClear()

        const outcome = store.persistPtyBinding(
          {
            worktreeId: 'wt-1',
            tabId: testCase.tabId,
            leafId: testCase.leafId,
            ptyId: 'pty-new',
            incarnationId: 'incarnation-new'
          },
          hostId,
          options
        )

        expect(outcome, testCase.name).toBe('refused')
        expect(store.getWorkspaceSession(hostId), testCase.name).toEqual(before)
        expect(flush, testCase.name).not.toHaveBeenCalled()
      }
    }
  })

  it('resolves panes from the target partition and reports it', async () => {
    const store = await createStore()
    const binding = {
      targetId: 'target-1',
      ptyId: APP_PTY_ID,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_1
    }

    expect(store.resolveExistingSshPtyBinding(binding)).toBeNull()
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID), SSH_HOST_ID)
    expect(store.resolveExistingSshPtyBinding(binding)).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_1,
      hostId: SSH_HOST_ID,
      ptyId: APP_PTY_ID
    })
  })

  // Why: buildHostIdByWorktreeId collapses repo-only SSH ownership onto the local partition, so a
  // pane the user still has open can be durable there while the target partition never saw it.
  it('falls back to the local spill partition and binds back into it', async () => {
    const store = await createStore()
    const binding = {
      targetId: 'target-1',
      ptyId: APP_PTY_ID,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_1
    }
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID))

    const resolved = store.resolveExistingSshPtyBinding(binding)
    expect(resolved).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_1,
      hostId: LOCAL_EXECUTION_HOST_ID,
      ptyId: APP_PTY_ID
    })
    expect(
      store.persistPtyBinding(
        { worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF_1, ptyId: 'pty-new' },
        resolved?.hostId,
        { mayCreate: false }
      )
    ).toBe('bound')
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId).toEqual({
      [LEAF_1]: 'pty-new'
    })
  })

  it('prefers the target partition when both partitions hold the pane', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID))
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID), SSH_HOST_ID)

    expect(
      store.resolveExistingSshPtyBinding({
        targetId: 'target-1',
        ptyId: APP_PTY_ID,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF_1
      })?.hostId
    ).toBe(SSH_HOST_ID)
  })

  it('refuses a complete lease when the pane is bound to a replacement PTY', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane('ssh:target-1@@pty-new'), SSH_HOST_ID)

    expect(
      store.resolveExistingSshPtyBinding({
        targetId: 'target-1',
        ptyId: APP_PTY_ID,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
    ).toBeNull()
  })

  it('refuses a stale single-leaf tab summary when the leaf binding is newer', async () => {
    const store = await createStore()
    const session = sessionWithExistingPane('ssh:target-1@@pty-new')
    session.tabsByWorktree['wt-1'][0].ptyId = APP_PTY_ID
    store.setWorkspaceSession(session, SSH_HOST_ID)

    expect(
      store.resolveExistingSshPtyBinding({
        targetId: 'target-1',
        ptyId: APP_PTY_ID,
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    ).toBeNull()
  })

  it('refuses conflicting copies of the same pane across host partitions', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID), SSH_HOST_ID)
    store.setWorkspaceSession(sessionWithExistingPane('ssh:target-1@@pty-new'))

    expect(
      store.resolveExistingSshPtyBinding({
        targetId: 'target-1',
        ptyId: APP_PTY_ID,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
    ).toBeNull()
  })

  it('resolves incomplete legacy leases only from a unique durable PTY binding', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane(APP_PTY_ID), SSH_HOST_ID)

    expect(
      store.resolveExistingSshPtyBinding({
        targetId: 'target-1',
        ptyId: 'pty-old',
        worktreeId: 'wt-1',
        tabId: 'tab-1'
      })
    ).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_1,
      hostId: SSH_HOST_ID,
      ptyId: APP_PTY_ID
    })
    expect(store.resolveExistingSshPtyBinding({ targetId: 'target-1', ptyId: APP_PTY_ID })).toEqual(
      {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: LEAF_1,
        hostId: SSH_HOST_ID,
        ptyId: APP_PTY_ID
      }
    )

    const ambiguous = sessionWithExistingPane(APP_PTY_ID)
    ambiguous.tabsByWorktree['wt-2'] = [
      terminalTab({ id: 'tab-2', worktreeId: 'wt-2', ptyId: APP_PTY_ID })
    ]
    ambiguous.terminalLayoutsByTabId['tab-2'] = {
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: APP_PTY_ID }
    }
    store.setWorkspaceSession(ambiguous, SSH_HOST_ID)

    expect(
      store.resolveExistingSshPtyBinding({ targetId: 'target-1', ptyId: APP_PTY_ID })
    ).toBeNull()
  })

  it('binds existing-only without topology growth', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane())
    const before = structuredClone(store.getWorkspaceSession())
    const flush = vi.spyOn(store, 'flushOrThrow')

    expect(
      store.persistPtyBinding(
        {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: LEAF_1,
          ptyId: 'pty-new',
          incarnationId: 'incarnation-new'
        },
        undefined,
        { mayCreate: false }
      )
    ).toBe('bound')
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].root).toEqual(
      before.terminalLayoutsByTabId['tab-1'].root
    )
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId).toEqual({
      [LEAF_1]: 'pty-new'
    })
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.['wt-1']).toBe(7)
    expect(flush).toHaveBeenCalledOnce()
  })

  it('compare-and-set refuses a pane that was replaced during reattach', async () => {
    const store = await createStore()
    const session = sessionWithExistingPane('pty-new')
    session.terminalPtyIncarnationsByPaneKey = { [`tab-1:${LEAF_1}`]: 'incarnation-new' }
    store.setWorkspaceSession(session)
    const before = structuredClone(store.getWorkspaceSession())
    const flush = vi.spyOn(store, 'flushOrThrow')

    expect(
      store.persistPtyBinding(
        {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: LEAF_1,
          ptyId: 'pty-old',
          incarnationId: 'incarnation-reattached'
        },
        undefined,
        {
          mayCreate: false,
          expectedBinding: { ptyId: 'pty-old', incarnationId: 'incarnation-old' }
        }
      )
    ).toBe('refused')
    expect(store.getWorkspaceSession()).toEqual(before)
    expect(flush).not.toHaveBeenCalled()
  })

  it('rolls back an existing-only bind when its durable flush fails', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithExistingPane())
    const before = structuredClone(store.getWorkspaceSession())
    vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() =>
      store.persistPtyBinding(
        {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: LEAF_1,
          ptyId: 'pty-new',
          incarnationId: 'incarnation-new'
        },
        undefined,
        { mayCreate: false }
      )
    ).toThrow('disk full')
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('leaves pane duplicates active until durable binding can arbitrate reattach', async () => {
    const store = await createStore()
    const timestamps = [
      ['pty-updated-old', 900, 100],
      ['pty-created-old', 100, 200],
      ['pty-a', 300, 200],
      ['pty-z', 300, 200]
    ] as const
    for (const [ptyId, createdAt, updatedAt] of timestamps) {
      store.upsertSshRemotePtyLease({
        targetId: 'target-1',
        ptyId,
        state: 'detached',
        createdAt,
        updatedAt
      })
    }
    store.upsertSshRemotePtyLease({
      targetId: 'target-1',
      ptyId: 'pty-identity-incomplete',
      state: 'detached',
      createdAt: 1,
      updatedAt: 1
    })
    for (const lease of store.getSshRemotePtyLeases('target-1')) {
      if (lease.ptyId !== 'pty-identity-incomplete') {
        Object.assign(lease, { worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF_1 })
      }
    }
    store.flush()

    const reloaded = await createStore()
    const collapsed = reloaded.getSshRemotePtyLeases('target-1')
    for (const ptyId of [...timestamps.map(([ptyId]) => ptyId), 'pty-identity-incomplete']) {
      expect(collapsed.find((lease) => lease.ptyId === ptyId)?.state, ptyId).toBe('detached')
    }
  })

  it('keeps a duplicate quarantine final across source-recovery state writes', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'target-1',
      ptyId: 'pty-discarded',
      state: 'attached'
    })
    const syncFlush = vi.spyOn(store, 'flush')
    await store.quarantineSshRemotePtyLeasesAsync('target-1', ['pty-discarded'])
    expect(syncFlush).not.toHaveBeenCalled()

    store.markSshRemotePtyLease('target-1', 'pty-discarded', 'detached')
    await store.markSshRemotePtyLeasesAttachedAsync('target-1', ['pty-discarded'])

    expect(store.getSshRemotePtyLeases('target-1')[0]).toEqual(
      expect.objectContaining({ ptyId: 'pty-discarded', state: 'expired' })
    )
  })

  it('rolls back an in-memory quarantine when its durable write fails', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'target-1',
      ptyId: 'pty-discarded',
      state: 'attached'
    })
    vi.spyOn(
      store as unknown as { flushDurableStateOrThrowAsync(): Promise<void> },
      'flushDurableStateOrThrowAsync'
    ).mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(
      store.quarantineSshRemotePtyLeasesAsync('target-1', ['pty-discarded'])
    ).rejects.toThrow('disk unavailable')

    expect(store.getSshRemotePtyLeases('target-1')[0]).toEqual(
      expect.objectContaining({ ptyId: 'pty-discarded', state: 'attached' })
    )
  })

  it('coalesces target reassignment collisions by remote PTY identity', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'target-old',
      ptyId: 'pty-shared',
      state: 'detached',
      createdAt: 1,
      updatedAt: 1
    })
    store.upsertSshRemotePtyLease({
      targetId: 'target-new',
      ptyId: 'pty-shared',
      state: 'attached',
      createdAt: 2,
      updatedAt: 2
    })

    store.reassignSshTargetId('target-old', 'target-new')

    expect(store.getSshRemotePtyLeases('target-new')).toEqual([
      expect.objectContaining({ ptyId: 'pty-shared', state: 'attached', updatedAt: 2 })
    ])
  })
})
