import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE_ID = 'repo::/worktree'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const LIVE_REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

function splitSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal 1',
          defaultTitle: 'Terminal 1',
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
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: RIGHT }
        },
        activeLeafId: RIGHT,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
      }
    }
  }
}

/** The phone's tabs for the split, as the window publishes them. */
function phoneSnapshot(session: WorkspaceSessionState): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = session.terminalLayoutsByTabId.tab!
  const pane = (leafId: string, ptyId: string, isActive: boolean) => ({
    type: 'terminal' as const,
    id: `tab::${leafId}`,
    parentTabId: 'tab',
    leafId,
    ptyId,
    title: 'Terminal 1',
    parentLayout,
    isActive
  })
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: `tab::${RIGHT}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [pane(LEFT, 'pty-left', false), pane(RIGHT, 'pty-right', true)]
  }
}

/** A runtime over one stored session, with the window's two split panes registered. */
function splitRuntime(): { runtime: OrcaRuntimeService; session: () => WorkspaceSessionState } {
  let session = splitSession()
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [LIVE_REPO],
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    })
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal 1',
        activeLeafId: RIGHT,
        layout: session.terminalLayoutsByTabId.tab!.root
      }
    ],
    leaves: [
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: LEFT, paneRuntimeId: 1, ptyId: 'pty-left' },
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: RIGHT, paneRuntimeId: 2, ptyId: 'pty-right' }
    ],
    mobileSessionTabs: [phoneSnapshot(session)]
  })
  return { runtime, session: () => session }
}

const panes = (session: WorkspaceSessionState) =>
  collectLeafIds(session.terminalLayoutsByTabId.tab?.root)

describe('layout-owner build: main closes an exited split pane itself', () => {
  it('closes a split pane whose shell exited cleanly', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT])
  })

  it('keeps a split pane whose process failed, behind its "Terminal exited" card', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', 1, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('keeps a split pane on a -1 nothing vouches for, as the window does on lost contact', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', -1)
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('keeps a split pane on a -1 only the provider reported, as the window does', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', -1, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  // Switch-on variants (ruled behaviour): any negative code keeps the pane, as the window does;
  // an asked-for close removes the pane through its own close command.
  it('keeps a split pane on a -1 after a stop was asked for', async () => {
    const { runtime, session } = splitRuntime()
    runtime.markPtyStopRequested('pty-right')
    await runtime.onPtyExit('pty-right', -1)
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('keeps a split pane on a -1 the host confirmed, so recovery can start a shell in it', async () => {
    const { runtime, session } = splitRuntime()
    await runtime.onPtyExit('pty-right', -1, undefined, { hostExitConfirmed: true })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('keeps a split pane whose exit came with no code, as when its socket closed', async () => {
    const { runtime, session } = splitRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty reports no exit code on a socket close, despite its types.
    await runtime.onPtyExit('pty-right', undefined as unknown as number, undefined, {
      providerExitObserved: true
    })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it("judges an older daemon's exit, which names no incarnation, by its code alone", async () => {
    const kept = splitRuntime()
    await kept.runtime.onPtyExit('pty-right', -1, undefined, { providerExitObserved: true })
    expect(panes(kept.session())).toEqual([LEFT, RIGHT])

    const closed = splitRuntime()
    await closed.runtime.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(panes(closed.session())).toEqual([LEFT])
  })

  it('tells the phone a closed pane retired, and sends it nothing for a pane main keeps', async () => {
    const phone = async (runtime: OrcaRuntimeService) => {
      const tabs = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      return {
        version: tabs.snapshotVersion,
        retired: (tabs.retiredTerminalSurfaces ?? []).map((surface) => surface.leafId)
      }
    }
    // Listing mints the panes' handles, which a retirement notice names.
    const closed = splitRuntime().runtime
    await phone(closed)
    await closed.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(await phone(closed)).toEqual({ version: 2, retired: [RIGHT] })

    const kept = splitRuntime().runtime
    await phone(kept)
    await kept.onPtyExit('pty-right', 1, undefined, { providerExitObserved: true })
    expect(await phone(kept)).toEqual({ version: 1, retired: [] })
  })

  it('keeps a newborn split that died while shown before any input or output', async () => {
    const { runtime, session } = splitRuntime()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-right' }, { ptyId: 'pty-left' })
    await runtime.onPtyExit('pty-right', 0, undefined, {
      providerExitObserved: true,
      viewShown: true
    })
    expect(panes(session())).toEqual([LEFT, RIGHT])
  })

  it('closes that newborn split when it ended unseen, as a hidden pane always closed', async () => {
    const { runtime, session } = splitRuntime()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-right' }, { ptyId: 'pty-left' })
    await runtime.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(panes(session())).toEqual([LEFT])
  })
})
