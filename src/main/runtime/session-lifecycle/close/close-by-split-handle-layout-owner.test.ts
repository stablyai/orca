import { describe, expect, it, vi } from 'vitest'
import {
  withDurableRuntimeStore,
  withRuntimePaneAdmission
} from '../../runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../../../persistence/terminal-topology/terminal-pane-admission'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/workspace`
const TAB_ID = 'tab-1'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY_ID = 'pty-source'
const SPLIT_PTY_ID = 'pty-split'

function sourceLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: SOURCE_LEAF_ID },
    activeLeafId: SOURCE_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [SOURCE_LEAF_ID]: SOURCE_PTY_ID }
  }
}

function persistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: SOURCE_PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { [TAB_ID]: sourceLayout() }
  }
}

function surface(
  leafId: string,
  ptyId: string | null,
  parentLayout: TerminalLayoutSnapshot
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: `${TAB_ID}::${leafId}`,
    parentTabId: TAB_ID,
    leafId,
    ptyId,
    title: 'Terminal',
    parentLayout,
    isActive: leafId === SOURCE_LEAF_ID
  }
}

/** The window's own publication: one surface per pane it has mounted. */
function windowSnapshot(
  version: number,
  surfaces: RuntimeMobileSessionTerminalTab[]
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'window',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: `${TAB_ID}::${SOURCE_LEAF_ID}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs: surfaces
  }
}

function windowGraph(
  leaves: { leafId: string; ptyId: string | null }[],
  snapshot: RuntimeMobileSessionTabsSnapshot
) {
  return {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: SOURCE_LEAF_ID,
        layout: null
      }
    ],
    leaves: leaves.map(({ leafId, ptyId }, index) => ({
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId
    })),
    mobileSessionTabs: [snapshot]
  }
}

/** What the window's list holds for main's new pane when it lands, after main's own. */
type WindowListing = 'pane-without-terminal' | 'no-new-pane'

function setup(listing: WindowListing) {
  let session = persistedSession()
  // The Store tells its write listeners after each write, as main's terminal list relies on.
  const written = new Set<(hostId: string | null) => void>()
  const write = (next: WorkspaceSessionState): void => {
    session = next
    for (const listener of written) {
      listener('local')
    }
  }
  const repo = {
    id: REPO_ID,
    path: '/workspace',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const store = withDurableRuntimeStore(
    withRuntimePaneAdmission({
      getRepos: () => [repo],
      getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      onWorkspaceSessionWritten: (listener: (hostId: string | null) => void) => {
        written.add(listener)
        return () => written.delete(listener)
      },
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        write(next)
      },
      // Main's own layout close, as the Store applies it.
      applyLayoutCommand: async (command: LayoutCommand, hostIds: readonly ExecutionHostId[]) => {
        const change = applyCommandToSession(hostIds[0]!, session, command)
        if (change.session) {
          write(change.session)
        }
        return change.value
      },
      persistPtyBinding: () => true,
      flushOrThrow: () => undefined
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries every store method a split and a tab close reach.
  const runtime = new OrcaRuntimeService(store as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/workspace',
      connectionId: null,
      repo,
      folderWorkspace: null
    }))
  })
  runtime.setPtyController({
    // The real spawn writes the new pane's binding into main's session; the fake does the same.
    spawn: vi.fn(async (args: { tabId?: string; leafId?: string }) => {
      const layout = session.terminalLayoutsByTabId[args.tabId!]!
      write({
        ...session,
        terminalLayoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [args.tabId!]: {
            ...layout,
            ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [args.leafId!]: SPLIT_PTY_ID }
          }
        }
      })
      return { id: SPLIT_PTY_ID }
    }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  // The window's list lags main: built before main's first frame (no new pane), or from it (the
  // pane, but not yet its terminal). Either lands after main's own listing.
  const revealTerminalSession = vi.fn(async (_worktreeId: string, args: { leafId?: string }) => {
    const newLeafId = args.leafId!
    const twoPanes = {
      ...sourceLayout(),
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, leafId: SOURCE_LEAF_ID },
        second: { type: 'leaf' as const, leafId: newLeafId }
      }
    }
    runtime.syncWindowGraph(
      1,
      windowGraph(
        [{ leafId: SOURCE_LEAF_ID, ptyId: SOURCE_PTY_ID }],
        windowSnapshot(
          2,
          listing === 'no-new-pane'
            ? [surface(SOURCE_LEAF_ID, SOURCE_PTY_ID, sourceLayout())]
            : [surface(SOURCE_LEAF_ID, SOURCE_PTY_ID, twoPanes), surface(newLeafId, null, twoPanes)]
        )
      )
    )
    return { tabId: TAB_ID }
  })
  const notifier = {
    revealTerminalSession,
    splitTerminal: vi.fn(),
    closeTerminalTab: vi.fn(async () => undefined)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split and the tab close call only these notices.
  runtime.setNotifier(notifier as never)
  runtime.syncWindowGraph(
    1,
    windowGraph(
      [{ leafId: SOURCE_LEAF_ID, ptyId: SOURCE_PTY_ID }],
      windowSnapshot(1, [surface(SOURCE_LEAF_ID, SOURCE_PTY_ID, sourceLayout())])
    )
  )
  runtime.registerPty(SOURCE_PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: SOURCE_LEAF_ID })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are declared on OrcaRuntimeService's inheritance chain.
  const internals = runtime as unknown as {
    issuePtyHandle: (pty: unknown) => string
    ptysById: Map<string, unknown>
  }
  // A terminal listing can name the source by its terminal, so the split runs main-side.
  const handle = internals.issuePtyHandle(internals.ptysById.get(SOURCE_PTY_ID))
  // Main's layout drops the pane, as a close of it would.
  const dropPane = (leafId: string): void => {
    const layout = session.terminalLayoutsByTabId[TAB_ID]!
    const { [leafId]: _dropped, ...ptyIdsByLeafId } = layout.ptyIdsByLeafId ?? {}
    write({
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [TAB_ID]: { ...layout, root: sourceLayout().root, ptyIdsByLeafId }
      }
    })
  }
  return { runtime, handle, dropPane }
}

describe("a tab close by a main-side split's handle while the window's list lags, in a layout-owner build", () => {
  it.each<WindowListing>(['pane-without-terminal', 'no-new-pane'])(
    "closes the tab on main's own record of the pane (%s)",
    async (listing) => {
      const { runtime, handle } = setup(listing)

      const split = await runtime.splitTerminal(handle, { direction: 'vertical' })

      await expect(runtime.closeTerminalTab(split.handle)).resolves.toMatchObject({
        tabId: TAB_ID,
        closeMode: 'tab'
      })
    }
  )

  it('still refuses once main no longer holds the pane', async () => {
    const { runtime, handle, dropPane } = setup('no-new-pane')

    const split = await runtime.splitTerminal(handle, { direction: 'vertical' })
    dropPane(split.leafId!)

    await expect(runtime.closeTerminalTab(split.handle)).rejects.toThrow('terminal_handle_stale')
  })
})
