import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/orca-profiles/constants'
import type { TerminalLayoutSnapshot } from '../../shared/workspace-layout/terminal-tab-types'
import { applyWorkspaceSessionEntriesPatch } from '../../shared/workspace-session/workspace-session-entries-patch'
import { windowSaveKeepingPaneTitles } from './window-save-pane-titles'

const reviewPane = '30000000-0000-4000-8000-000000000001'
const testsPane = '30000000-0000-4000-8000-000000000002'
const layout: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: reviewPane },
    second: { type: 'leaf', leafId: testsPane }
  },
  activeLeafId: reviewPane,
  expandedLeafId: null,
  ptyIdsByLeafId: { [reviewPane]: 'review-pty', [testsPane]: 'tests-pty' },
  titlesByLeafId: { [testsPane]: 'Tests' }
}

function applyLayout(storedLayout: TerminalLayoutSnapshot, savedLayout: TerminalLayoutSnapshot) {
  const stored = {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: { tab: storedLayout }
  }
  const patch = applyWorkspaceSessionEntriesPatch(stored, {
    fields: {},
    entries: { terminalLayoutsByTabId: { set: { tab: savedLayout }, remove: [] } }
  })
  return windowSaveKeepingPaneTitles(stored, patch).terminalLayoutsByTabId?.tab
}

describe('pane titles in a workspace session save', () => {
  it('keeps the saved title while applying a layout captured before the rename', () => {
    const saved = { ...layout, titlesByLeafId: { [reviewPane]: 'Review', [testsPane]: 'Tests' } }
    expect(applyLayout(saved, { ...layout, expandedLeafId: reviewPane })).toMatchObject({
      expandedLeafId: reviewPane,
      titlesByLeafId: { [reviewPane]: 'Review', [testsPane]: 'Tests' }
    })
  })

  it('applies a clear and a sibling rename without replaying an older title', () => {
    const named = {
      ...layout,
      titlesByLeafId: { [reviewPane]: 'Review', [testsPane]: 'Tests' },
      paneTitleRevisionByLeafId: { [reviewPane]: 10, [testsPane]: 20 }
    }
    const cleared = {
      ...layout,
      paneTitleRevisionByLeafId: { [reviewPane]: 30, [testsPane]: 20 }
    }
    expect(applyLayout(named, cleared)).toEqual(cleared)

    const oldReviewWithNewTests = {
      ...named,
      titlesByLeafId: { [reviewPane]: 'Review', [testsPane]: 'CI' },
      paneTitleRevisionByLeafId: { [reviewPane]: 10, [testsPane]: 40 }
    }
    expect(applyLayout(cleared, oldReviewWithNewTests)).toMatchObject({
      titlesByLeafId: { [testsPane]: 'CI' },
      paneTitleRevisionByLeafId: { [reviewPane]: 30, [testsPane]: 40 }
    })
    expect(applyLayout(cleared, oldReviewWithNewTests)?.titlesByLeafId).not.toHaveProperty(
      reviewPane
    )
  })
})
