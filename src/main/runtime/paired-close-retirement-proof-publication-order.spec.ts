import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { sessionLayoutApply } from './__fixtures__/main-layout-close-fixture'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

export function registerPairedCloseRetirementProofPublicationOrderTests(): void {
  /**
   * A paired client may only drop a mirrored terminal on host evidence: a `retiredTerminalSurfaces`
   * proof naming the handle, or two authoritative `terminal.list` inventories that omit it. The
   * second needs two host publications, and a quiet workspace produces one — so the proof is the
   * only evidence that rides the frame carrying the retraction, and it has to be published whichever
   * order the close's two halves (renderer republication, PTY exit) land in.
   */

  const WORKTREE_ID = 'repo::/worktree'
  const LEAF_ID = '11111111-1111-4111-8111-111111111111'
  const LIVE_REPO = {
    id: 'repo',
    path: '/worktree',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  } as const

  function makeSnapshot(): RuntimeMobileSessionTabsSnapshot {
    return {
      worktree: WORKTREE_ID,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: `tab::${LEAF_ID}`,
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: `tab::${LEAF_ID}`,
          parentTabId: 'tab',
          leafId: LEAF_ID,
          ptyId: 'pty-left',
          title: 'Left',
          parentLayout: {
            root: { type: 'leaf' as const, leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'pty-left' }
          },
          isActive: true
        }
      ]
    }
  }

  function makePersistedSession(): WorkspaceSessionState {
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
          root: { type: 'leaf' as const, leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-left' }
        }
      },
      // The spawn commit's binding: the terminal's incarnation, as it registers below.
      terminalPtyIncarnationsByPaneKey: { [`tab:${LEAF_ID}`]: 'incarnation-a' }
    }
  }

  function createHost(): {
    runtime: OrcaRuntimeService
    handle: string
    retirePersistedSurface: () => Promise<void>
  } {
    let session = makePersistedSession()
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence and graph methods exercised by the test.
      withDurableRuntimeStore({
        getRepos: () => [LIVE_REPO],
        getWorkspaceSession: () => session,
        // As a profile store: main's layout indexes the session under its host.
        getWorkspaceSessionHostIds: () => ['local'],
        setWorkspaceSession: (next: WorkspaceSessionState) => {
          session = next
        },
        // Main's `layout.apply` on this partition, as the Store applies it.
        applyLayoutCommand: sessionLayoutApply({
          get: () => session,
          set: (next) => (session = next)
        }),
        flushOrThrow: vi.fn()
      }) as never
    )
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-left'
        }
      ],
      mobileSessionTabs: [makeSnapshot()]
    })
    runtime.registerPty('pty-left', WORKTREE_ID, null, {
      tabId: 'tab',
      leafId: LEAF_ID,
      incarnationId: 'incarnation-a'
    })
    // The mirror binds panes by terminal handle, so the handle has to exist before the close.
    const handle = runtime.preAllocateHandleForPty('pty-left')
    runtime.registerPreAllocatedHandleForPty('pty-left', handle)
    return {
      runtime,
      handle,
      // The close de-persists the tab before the renderer republishes: switch-on main's layout
      // close, switch-off the renderer's own close transaction.
      retirePersistedSurface: async () => {
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await runtime.applyLayoutCommand({
            type: 'closeTabs',
            workspace: WORKTREE_ID,
            tabIds: ['tab'],
            recordClose: 'user'
          })
          return
        }
        session = { ...session, tabsByWorktree: {}, terminalLayoutsByTabId: {} }
      }
    }
  }

  /** What the host renderer publishes once it has retired the tab it was told to close. */
  function republishWithoutTheSurface(runtime: OrcaRuntimeService): void {
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer',
          snapshotVersion: 5,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
  }

  describe('retirement proof publication vs. renderer republication order', () => {
    it('publishes the proof when the exit lands before the renderer drops the surface', async () => {
      const { runtime, handle } = createHost()

      await runtime.onPtyExit('pty-left', 0, 'incarnation-a')
      republishWithoutTheSurface(runtime)

      const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(published.tabs).toEqual([])
      expect(published.retiredTerminalSurfaces).toEqual([
        expect.objectContaining({ parentTabId: 'tab', leafId: LEAF_ID, terminal: handle })
      ])
    })

    it('publishes the proof when the renderer drops the surface before the exit lands', async () => {
      const { runtime, handle, retirePersistedSurface } = createHost()

      await retirePersistedSurface()
      republishWithoutTheSurface(runtime)
      await runtime.onPtyExit('pty-left', 0, 'incarnation-a')

      const published = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(published.tabs).toEqual([])
      expect(published.retiredTerminalSurfaces).toEqual([
        expect.objectContaining({ parentTabId: 'tab', leafId: LEAF_ID, terminal: handle })
      ])
    })

    // Why a subscriber and not just the stored snapshot: a mirror only ever sees frames. A proof
    // that lands in state without a frame to carry it is the same silence from the client's side.
    it('fans the proof out to a paired subscriber, not just into stored state', async () => {
      const { runtime, handle, retirePersistedSurface } = createHost()
      const frames: RuntimeMobileSessionTabsResult[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged(
        (frame) => frames.push(frame),
        'paired-client'
      )

      try {
        await retirePersistedSurface()
        republishWithoutTheSurface(runtime)
        await runtime.onPtyExit('pty-left', 0, 'incarnation-a')
      } finally {
        unsubscribe()
      }

      expect(
        frames.some((frame) =>
          frame.retiredTerminalSurfaces?.some(
            (proof) =>
              proof.terminal === handle && proof.parentTabId === 'tab' && proof.leafId === LEAF_ID
          )
        )
      ).toBe(true)
    })
  })
}
