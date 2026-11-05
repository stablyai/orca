import { withDurableRuntimeStore } from '../../runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

import { OrcaRuntimeService } from '../../orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'
// #9343 hydration drops sessions for removed repos; persisted fixtures must advertise their live repo.
const LIVE_REPO = {
  id: REPO_ID,
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const

function runtimeStore(
  overrides: {
    getWorkspaceSession?: () => WorkspaceSessionState
    setWorkspaceSession?: (session: WorkspaceSessionState) => void
    flushOrThrow?: () => void
  } = {}
): never {
  return {
    getRepos: () => [LIVE_REPO],
    ...overrides
  } as never
}

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
  it('fences an early-exited replacement even when its pane already exists', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-old'
    })

    runtime.onPtySpawned('pty-left', 'incarnation-replacement')
    await runtime.onPtyExit('pty-left', 0, 'incarnation-replacement')

    expect(() =>
      runtime.assertPtyRegistrationAllowed('pty-left', 'incarnation-replacement')
    ).toThrow('agent_session_exited_during_start')
    runtime.releaseRejectedPtyRegistrationFence('pty-left', 'incarnation-replacement')
    const internals = runtime as unknown as {
      pendingPtyRegistrationIncarnations: Map<string, string | null>
    }
    expect(internals.pendingPtyRegistrationIncarnations.size).toBe(0)
  })

  it('retires the exact split leaf and rejects a stale renderer resurrection', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const staleSnapshot = makeSplitSnapshot()
    syncSplit(runtime, staleSnapshot)
    const leftBeforeExit = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs.find(
      (tab) => tab.type === 'terminal' && tab.id === 'tab::left'
    )
    const leftHandle =
      leftBeforeExit?.type === 'terminal' && leftBeforeExit.status === 'ready'
        ? leftBeforeExit.terminal
        : null

    await runtime.onPtyExit('pty-left', 0)

    expect(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).toMatchObject({
      activeTabId: 'tab::right',
      retiredTerminalSurfaces: [
        {
          parentTabId: 'tab',
          leafId: 'left',
          ptyId: 'pty-left',
          terminal: leftHandle
        }
      ],
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

  it('ignores a delayed exit from an older incarnation of a reused PTY id', async () => {
    const setWorkspaceSession = vi.fn()
    const runtime = new OrcaRuntimeService(
      runtimeStore({
        getWorkspaceSession: () => makePersistedSplitSession(),
        setWorkspaceSession
      })
    )
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

    await runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ id: 'tab::left', status: 'ready' }),
      expect.objectContaining({ id: 'tab::right', status: 'ready' })
    ])
    expect(setWorkspaceSession).not.toHaveBeenCalled()
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
    const runtime = new OrcaRuntimeService(
      runtimeStore(
        withDurableRuntimeStore({
          getWorkspaceSession: () => session,
          setWorkspaceSession,
          flushOrThrow: vi.fn()
        })
      )
    )
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

    await runtime.onPtyExit('pty-shared', 0, 'incarnation-exiting')

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

  it('keeps the in-memory retirement when the durable flush fails', async () => {
    let session = makePersistedSplitSession()
    const original = structuredClone(session)
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
      session = next
    })
    const runtime = new OrcaRuntimeService(
      runtimeStore(
        withDurableRuntimeStore({
          getWorkspaceSession: () => session,
          setWorkspaceSession,
          flushOrThrow: vi.fn(() => {
            throw new Error('disk unavailable')
          })
        })
      )
    )
    runtime.attachWindow(1)
    syncSplit(runtime)
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: 'left',
      incarnationId: 'incarnation-a'
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runtime.onPtyExit('pty-left', 0, 'incarnation-a')

    expect(session).not.toEqual(original)
    expect(session.terminalLayoutsByTabId.tab?.ptyIdsByLeafId).toEqual({ right: 'pty-right' })
    expect(setWorkspaceSession).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })
})
