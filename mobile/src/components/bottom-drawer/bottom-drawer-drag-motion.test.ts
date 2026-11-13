import { describe, expect, it } from 'vitest'
import { shouldDismissBottomDrawer } from './bottom-drawer-drag-motion'

describe('bottom drawer release', () => {
  it('judges where the sheet is heading, not where the finger let go', () => {
    // 120 px down on a tall sheet stays open when released slowly, and closes when thrown.
    expect(shouldDismissBottomDrawer(120, 100, 777)).toBe(false)
    expect(shouldDismissBottomDrawer(120, 700, 777)).toBe(true)
    // A flick back up keeps the sheet even after a long drag.
    expect(shouldDismissBottomDrawer(180, -600, 777)).toBe(false)
  })
})
