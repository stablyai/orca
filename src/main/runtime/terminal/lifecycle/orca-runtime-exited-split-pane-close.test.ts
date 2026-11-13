import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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

async function splitRuntime(): Promise<{
  runtime: OrcaRuntimeService
  session: () => WorkspaceSessionState
}> {
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
  await runtime.syncWindowGraph(1, {
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

describe('layout-owner build: main closes an exited split pane itself', () => {
  it('tells the phone a closed pane retired, and sends it nothing for a pane main keeps', async () => {
    const phone = async (runtime: OrcaRuntimeService) => {
      const tabs = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      return {
        version: tabs.snapshotVersion,
        retired: (tabs.retiredTerminalSurfaces ?? []).map((surface) => surface.leafId)
      }
    }
    // Listing mints the handles named by retirement notices.
    const closed = (await splitRuntime()).runtime
    await phone(closed)
    await closed.onPtyExit('pty-right', 0, undefined, { providerExitObserved: true })
    expect(await phone(closed)).toEqual({ version: 2, retired: [RIGHT] })

    const kept = (await splitRuntime()).runtime
    await phone(kept)
    await kept.onPtyExit('pty-right', 1, undefined, { providerExitObserved: true })
    expect(await phone(kept)).toEqual({ version: 1, retired: [] })
  })
})
