import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { agentLaunchPaneEvidence } from './agent-launch-pane-evidence'

const WT = 'repo-1::/tmp/evidence'
const TAB = 'tab-evidence'
const LEAF = '66666666-6666-4666-8666-666666666666'

function storeWith(session: Record<string, unknown>): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a store carrying only the persisted session these readers use.
  return { getWorkspaceSession: () => session } as never
}

const launchTab = {
  id: TAB,
  worktreeId: WT,
  ptyId: null,
  agentLaunchPane: { leafId: LEAF, outcome: { kind: 'unconfirmed' } }
}

describe('what a launch pane spawn reads', () => {
  it("counts a restored pane's persisted binding as a process that holds it", () => {
    const evidence = agentLaunchPaneEvidence(
      {
        store: storeWith({
          tabsByWorktree: { [WT]: [launchTab] },
          terminalLayoutsByTabId: { [TAB]: { ptyIdsByLeafId: { [LEAF]: 'pty-survived' } } }
        })
      },
      { worktreeId: WT, tabId: TAB, leafId: LEAF }
    )
    expect(evidence.isPaneLive(makePaneKey(TAB, LEAF))).toBe(true)
  })

  it('reads the launch the tab keeps for this leaf only', () => {
    const store = storeWith({ tabsByWorktree: { [WT]: [launchTab] } })
    expect(
      agentLaunchPaneEvidence(
        { store },
        { worktreeId: WT, tabId: TAB, leafId: LEAF }
      ).launchPaneOnTab()
    ).toEqual({ leafId: LEAF, outcome: { kind: 'unconfirmed' } })
    expect(
      agentLaunchPaneEvidence(
        { store },
        { worktreeId: WT, tabId: TAB, leafId: '77777777-7777-4777-8777-777777777777' }
      ).launchPaneOnTab()
    ).toBeNull()
    expect(
      agentLaunchPaneEvidence({ store }, { worktreeId: WT, tabId: TAB, leafId: LEAF }).isPaneLive(
        makePaneKey(TAB, LEAF)
      )
    ).toBe(false)
  })
})
