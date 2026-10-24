import { describe, expect, it } from 'vitest'
import {
  workspaceOptionsAccessibilityLabel,
  workspaceOptionsBadgeText
} from './workspace-options-copy'

describe('the Workspace options chip', () => {
  it('badges the active-filter count as the desktop does, capped at 9+', () => {
    expect(workspaceOptionsBadgeText(0)).toBeNull()
    expect(workspaceOptionsBadgeText(2)).toBe('2')
    expect(workspaceOptionsBadgeText(12)).toBe('9+')
  })

  it("reads to screen readers as the desktop's trigger does", () => {
    expect(workspaceOptionsAccessibilityLabel(0)).toBe('Workspace options')
    expect(workspaceOptionsAccessibilityLabel(1)).toBe('Workspace options (1 filter active)')
    expect(workspaceOptionsAccessibilityLabel(3)).toBe('Workspace options (3 filters active)')
  })
})
