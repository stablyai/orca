import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { manualTitleAdmission } from './manual-title-admission'

const pane = { worktreeId: 'wt_1', tabId: 'tab_1' }

function partition(customTitle: string | null | undefined): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only tabsByWorktree.
  return {
    tabsByWorktree: { wt_1: [{ id: 'tab_1', customTitle }] }
  } as unknown as WorkspaceSessionState
}

describe('manualTitleAdmission', () => {
  it('admits when the saved manual name matches, trimmed', () => {
    expect(manualTitleAdmission([partition('  Fix login ')], pane, 'Fix login')).toBe(true)
  })

  it('treats no manual name as the empty string', () => {
    expect(manualTitleAdmission([partition(null)], pane, '')).toBe(true)
    expect(manualTitleAdmission([partition(undefined)], pane, '  ')).toBe(true)
  })

  it('refuses with terminal_title_changed when the name differs', () => {
    expect(manualTitleAdmission([partition('User name')], pane, '')).toBe('terminal_title_changed')
    expect(manualTitleAdmission([partition(null)], pane, 'Old')).toBe('terminal_title_changed')
  })

  it('sees a rename an earlier queued write saved', () => {
    const state = partition(null)
    expect(manualTitleAdmission([state], pane, '')).toBe(true)
    state.tabsByWorktree.wt_1![0]!.customTitle = 'First'
    expect(manualTitleAdmission([state], pane, '')).toBe('terminal_title_changed')
  })

  it('refuses as a missing tab when the partition no longer holds it', () => {
    expect(manualTitleAdmission([], pane, '')).toBe(false)
    expect(manualTitleAdmission(undefined, pane, '')).toBe(false)
  })
})
