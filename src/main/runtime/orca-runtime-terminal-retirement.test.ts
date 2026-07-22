import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { sanitizeWorkspaceSessionTerminalRetirements } from './mobile-session-terminal-persistence-retirement'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'

function makeSplitSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: 'left' },
      second: { type: 'leaf' as const, leafId: 'right' }
    },
    activeLeafId: 'left',
    expandedLeafId: 'left',
    ptyIdsByLeafId: { left: 'pty-left', right: 'pty-right' }
  }
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: 'tab::left',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'tab::left',
        parentTabId: 'tab',
        leafId: 'left',
        ptyId: 'pty-left',
        title: 'Left',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: 'tab::right',
        parentTabId: 'tab',
        leafId: 'right',
        ptyId: 'pty-right',
        title: 'Right',
        parentLayout,
        isActive: false
      }
    ]
  }
}

function syncSplit(runtime: OrcaRuntimeService, snapshot = makeSplitSnapshot()): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: 'left',
        layout:
          snapshot.tabs[0]?.type === 'terminal'
            ? (snapshot.tabs[0].parentLayout?.root ?? null)
            : null
      }
    ],
    leaves: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        leafId: 'left',
        paneRuntimeId: 1,
        ptyId: 'pty-left'
      },
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        leafId: 'right',
        paneRuntimeId: 2,
        ptyId: 'pty-right'
      }
    ],
    mobileSessionTabs: [snapshot]
  })
}

function makePersistedSplitSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split' as const,
          direction: 'vertical' as const,
          first: { type: 'leaf' as const, leafId: 'left' },
          second: { type: 'leaf' as const, leafId: 'right' }
        },
        activeLeafId: 'left',
        expandedLeafId: null,
        ptyIdsByLeafId: { left: 'pty-left', right: 'pty-right' }
      }
    }
  }
}

describe('OrcaRuntimeService terminal surface retirement', () => {
  it('releases each early-exit fence after its matching registration is rejected', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
    }

    for (let index = 0; index < 1_000; index += 1) {
      const ptyId = `pty-early-${index}`
      const incarnationId = `incarnation-${index}`
      runtime.beginPtyRegistration(ptyId, incarnationId)
      runtime.onPtyExit(ptyId, 0, incarnationId)
      expect(() => runtime.assertPtyRegistrationAllowed(ptyId, incarnationId)).toThrow(
        'agent_session_exited_during_start'
      )
      runtime.releaseRejectedPtyRegistrationFence(ptyId, incarnationId)
    }

    expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
  })

  it('does not retain fences for completed surface-less lifecycles', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
      pendingPtyRegistrationIncarnations: Map<string, string | null>
    }

    for (let index = 0; index < 1_000; index += 1) {
      runtime.onPtySpawned(`pty-headless-${index}`, `incarnation-${index}`, {
        awaitsRegistration: false
      })
      runtime.onPtyExit(`pty-headless-${index}`, 0, `incarnation-${index}`)
    }

    expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
    expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
  })

  it('fences an early-exited replacement even when its pane already exists', () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-old'
    })

    runtime.onPtySpawned('pty-left', 'incarnation-replacement')
    runtime.onPtyExit('pty-left', 0, 'incarnation-replacement')

    expect(() =>
      runtime.assertPtyRegistrationAllowed('pty-left', 'incarnation-replacement')
    ).toThrow('agent_session_exited_during_start')
    runtime.releaseRejectedPtyRegistrationFence('pty-left', 'incarnation-replacement')
    const internals = runtime as unknown as {
      earlyExitedPtyIncarnations: Map<string, string | null>
      pendingPtyRegistrationIncarnations: Map<string, string | null>
    }
    expect(internals.earlyExitedPtyIncarnations.size).toBe(0)
    expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
  })

  it('retires the exact split leaf and rejects a stale renderer resurrection', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const staleSnapshot = makeSplitSnapshot()
    syncSplit(runtime, staleSnapshot)

    runtime.onPtyExit('pty-left', 0)

    expect(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).toMatchObject({
      activeTabId: 'tab::right',
      tabs: [
        {
          id: 'tab::right',
          status: 'ready',
          terminal: expect.stringMatching(/^term_/),
          isActive: true,
          parentLayout: {
            root: { type: 'leaf', leafId: 'right' },
            activeLeafId: 'right',
            expandedLeafId: null,
            ptyIdsByLeafId: { right: 'pty-right' }
          }
        }
      ]
    })

    syncSplit(runtime, { ...staleSnapshot, snapshotVersion: 2 })

    const afterStaleFrame = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(afterStaleFrame.tabs.map((tab) => tab.id)).toEqual(['tab::right'])
  })

  it('rejects one stale shared-PTY surface without removing its live sibling', () => {
    const session = makePersistedSplitSession()
    session.tabsByWorktree[WORKTREE_ID]![0]!.ptyId = 'pty-shared'
    session.terminalLayoutsByTabId.tab = {
      root: { type: 'leaf', leafId: 'right' },
      activeLeafId: 'right',
      expandedLeafId: null,
      ptyIdsByLeafId: { right: 'pty-shared' }
    }
    session.terminalPtyIncarnationsByPaneKey = { 'tab:right': 'incarnation-current' }
    session.terminalTopologyRevisionByRepoId = { [REPO_ID]: 1 }
    const runtime = new OrcaRuntimeService({ getWorkspaceSession: () => session } as never)
    runtime.attachWindow(1)
    runtime.registerPty('pty-shared', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'right',
      incarnationId: 'incarnation-current'
    })
    const snapshot = makeSplitSnapshot()
    const incoming = {
      ...snapshot,
      tabs: snapshot.tabs.map((tab) =>
        tab.type === 'terminal'
          ? {
              ...tab,
              ptyId: 'pty-shared',
              parentLayout: tab.parentLayout
                ? {
                    ...tab.parentLayout,
                    ptyIdsByLeafId: { left: 'pty-shared', right: 'pty-shared' }
                  }
                : undefined
            }
          : tab
      )
    }
    type IncomingTerminalTab = Extract<(typeof incoming.tabs)[number], { type: 'terminal' }>
    const rightTab = incoming.tabs.find(
      (tab): tab is IncomingTerminalTab => tab.type === 'terminal' && tab.leafId === 'right'
    )!
    const hostSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...incoming,
      activeTabId: rightTab.id,
      tabs: [
        {
          ...rightTab,
          parentLayout: {
            root: { type: 'leaf', leafId: 'right' },
            activeLeafId: 'right',
            expandedLeafId: null,
            ptyIdsByLeafId: { right: 'pty-shared' }
          }
        }
      ]
    }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'right',
          layout: { type: 'leaf', leafId: 'right' }
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          leafId: 'right',
          paneRuntimeId: 2,
          ptyId: 'pty-shared'
        }
      ],
      mobileSessionTabs: [hostSnapshot]
    })
    ;(
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.set(WORKTREE_ID, hostSnapshot)

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'right',
          layout: incoming.tabs[0]?.type === 'terminal' ? incoming.tabs[0].parentLayout!.root : null
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          leafId: 'left',
          paneRuntimeId: 1,
          ptyId: 'pty-shared'
        },
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          leafId: 'right',
          paneRuntimeId: 2,
          ptyId: 'pty-shared'
        }
      ],
      mobileSessionTabs: [incoming]
    })

    const internalSnapshot = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.get(WORKTREE_ID)
    expect(internalSnapshot?.tabs).toEqual([
      expect.objectContaining({ id: 'tab::right', ptyId: 'pty-shared' })
    ])
  })

  it('honors a legacy persisted tombstone before its first migration write', async () => {
    const session = makePersistedSplitSession()
    session.tabsByWorktree[WORKTREE_ID]![0]!.ptyId = 'pty-right'
    session.terminalLayoutsByTabId.tab = {
      root: { type: 'leaf', leafId: 'right' },
      activeLeafId: 'right',
      expandedLeafId: null,
      ptyIdsByLeafId: { right: 'pty-right' }
    }
    Object.assign(session, {
      terminalSurfaceTombstonesByPaneKey: {
        'tab:left': {
          worktreeId: WORKTREE_ID,
          parentTabId: 'tab',
          leafId: 'left',
          ptyId: 'pty-left',
          incarnationId: 'incarnation-left',
          retiredAt: 42
        }
      }
    })
    const runtime = new OrcaRuntimeService({ getWorkspaceSession: () => session } as never)
    runtime.attachWindow(1)
    runtime.registerPty('pty-right', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'right',
      incarnationId: 'incarnation-right'
    })

    syncSplit(runtime)

    const tabs = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'terminal', ptyId: 'pty-right' })
  })

  it('publishes the host-rebased layout after a stale client pane update', async () => {
    let session = makePersistedSplitSession()
    session.tabsByWorktree[WORKTREE_ID]![0]!.ptyId = 'pty-right'
    session.terminalLayoutsByTabId.tab = {
      root: { type: 'leaf', leafId: 'right' },
      activeLeafId: 'right',
      expandedLeafId: null,
      ptyIdsByLeafId: { right: 'pty-right' }
    }
    Object.assign(session, {
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
    })
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (incoming: WorkspaceSessionState) => {
        session = sanitizeWorkspaceSessionTerminalRetirements(incoming, session)
      }
    } as never)

    await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    await runtime.updateMobileSessionPaneLayout(`id:${WORKTREE_ID}`, {
      tabId: 'tab',
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'left' },
        second: { type: 'leaf', leafId: 'right' }
      },
      expandedLeafId: null,
      titlesByLeafId: { right: 'Survivor' }
    })

    const tabs = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({
      type: 'terminal',
      ptyId: 'pty-right',
      parentLayout: {
        root: { type: 'leaf', leafId: 'right' }
      }
    })
  })

  it('retires a permanently exited surface despite a stale sleeping record', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { 'tab:left': {} as never }
    }
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: vi.fn(),
      flushOrThrow: vi.fn()
    } as never)
    runtime.attachWindow(1)
    syncSplit(runtime)

    runtime.onPtyExit('pty-left', 0)

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(result.tabs.find((tab) => tab.id === 'tab::left')).toBeUndefined()
    expect(result.tabs.find((tab) => tab.id === 'tab::right')).toMatchObject({
      status: 'ready'
    })
  })

  it('ignores a delayed exit from an older incarnation of a reused PTY id', async () => {
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => makePersistedSplitSession(),
      setWorkspaceSession
    } as never)
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-b'
    })

    runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::left', status: 'ready' }),
      expect.objectContaining({ id: 'tab::right', status: 'ready' })
    ])
    expect(setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('retires a durable surface after reconnect proves a newer incarnation', async () => {
    const session = makePersistedSplitSession()
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession,
      flushOrThrow: vi.fn()
    } as never)
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-before-reconnect'
    })

    runtime.acceptPtyIncarnationForExit('pty-left', 'incarnation-after-reconnect')
    runtime.onPtyExit('pty-left', 0, 'incarnation-after-reconnect')

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::right', status: 'ready' })
    ])
    expect(setWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalLayoutsByTabId: {
          tab: expect.objectContaining({
            root: { type: 'leaf', leafId: 'right' },
            ptyIdsByLeafId: { right: 'pty-right' }
          })
        }
      })
    )
  })

  it('publishes only same-repo retirements individually accepted by persistence', async () => {
    let session = makePersistedSplitSession()
    session.terminalLayoutsByTabId.tab.ptyIdsByLeafId = {
      left: 'pty-shared',
      right: 'pty-shared'
    }
    session.tabsByWorktree[WORKTREE_ID]![0]!.ptyId = 'pty-shared'
    session.terminalPtyIncarnationsByPaneKey = {
      'tab:left': 'incarnation-exiting',
      'tab:right': 'incarnation-newer'
    }
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
      session = next
    })
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession,
      flushOrThrow: vi.fn()
    } as never)
    runtime.attachWindow(1)
    const snapshot = makeSplitSnapshot()
    const sharedSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      tabs: snapshot.tabs.map((tab) =>
        tab.type === 'terminal'
          ? {
              ...tab,
              ptyId: 'pty-shared',
              parentLayout: tab.parentLayout
                ? {
                    ...tab.parentLayout,
                    ptyIdsByLeafId: { left: 'pty-shared', right: 'pty-shared' }
                  }
                : undefined
            }
          : tab
      )
    }
    syncSplit(runtime, sharedSnapshot)
    runtime.registerPty('pty-shared', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-exiting'
    })
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => published.push(event))

    runtime.onPtyExit('pty-shared', 0, 'incarnation-exiting')

    expect(session.terminalLayoutsByTabId.tab).toMatchObject({
      root: { type: 'leaf', leafId: 'right' },
      ptyIdsByLeafId: { right: 'pty-shared' }
    })
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      'tab:right': 'incarnation-newer'
    })
    expect(published.at(-1)?.tabs).toEqual([
      expect.objectContaining({
        ptyId: 'pty-shared',
        parentLayout: expect.objectContaining({ root: { type: 'leaf', leafId: 'right' } })
      })
    ])
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({
        ptyId: 'pty-shared',
        parentLayout: expect.objectContaining({ root: { type: 'leaf', leafId: 'right' } })
      })
    ])
    expect(setWorkspaceSession).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('de-persists an exact surface even when there is no mobile snapshot', () => {
    const session = makePersistedSplitSession()
    const setWorkspaceSession = vi.fn()
    const flushOrThrow = vi.fn()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession,
      flushOrThrow
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'left',
          layout: { type: 'leaf', leafId: 'left' }
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          leafId: 'left',
          paneRuntimeId: 1,
          ptyId: 'pty-left'
        }
      ]
    })
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })

    runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect(setWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalLayoutsByTabId: {
          tab: expect.objectContaining({
            root: { type: 'leaf', leafId: 'right' },
            ptyIdsByLeafId: { right: 'pty-right' }
          })
        },
        terminalSurfaceTombstonesByPaneKey: {},
        terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
      })
    )
    expect(flushOrThrow).toHaveBeenCalledOnce()
  })

  it('does not publish absence when the durable retirement flush fails', async () => {
    const session = makePersistedSplitSession()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: vi.fn(),
      flushOrThrow: vi.fn(() => {
        throw new Error('disk unavailable')
      })
    } as never)
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })
    const events: unknown[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => events.push(event))

    runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::left' }),
      expect.objectContaining({ id: 'tab::right' })
    ])
    expect(events).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      '[runtime] failed to persist terminal retirement:',
      expect.any(Error)
    )
    unsubscribe()
    errorSpy.mockRestore()
  })
})
