// Switch-off builds permit paired hosts to add panes and do not enforce main-owned close records.
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { admitPaneToSession, applyCommandToSession } from './terminal-pane-admission'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const WORKTREE = 'repo-1::/workspace'
const TAB = 'tab-1'

describe('a runtime pane in the shipped build', () => {
  it("writes a client tab's second pane under the tab's id", () => {
    const first = admitPaneToSession('local', getDefaultWorkspaceSession(), {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    expect(first.value).toBe('admitted')
    const second = admitPaneToSession('local', first.session!, {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: '22222222-2222-4222-8222-222222222222'
    })
    expect(second.value).toBe('admitted')
  })

  it('writes a create under the id of a tab the user closed, on both pane write paths', () => {
    const create = {
      type: 'createTerminalTab',
      workspace: WORKTREE,
      tabId: TAB,
      leafId: '11111111-1111-4111-8111-111111111111'
    } as const
    const opened = applyCommandToSession('local', getDefaultWorkspaceSession(), create)
    const closed = applyCommandToSession('local', opened.session!, {
      type: 'closeTabs',
      workspace: WORKTREE,
      tabIds: [TAB],
      recordClose: 'user'
    })
    expect(closed.value.ok).toBe(true)
    const afterClose = closed.session!
    expect(afterClose.closedTerminalTabTombstonesByTabId?.[TAB]).toBeDefined()

    expect(applyCommandToSession('local', afterClose, create).value.ok).toBe(true)
    expect(admitPaneToSession('local', afterClose, create).value).toBe('admitted')
  })
})
