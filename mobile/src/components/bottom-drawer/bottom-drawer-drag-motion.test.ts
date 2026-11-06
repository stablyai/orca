import { describe, expect, it } from 'vitest'
import {
  bottomDrawerDismissMotion,
  bottomDrawerScrim,
  shouldDismissBottomDrawer
} from './bottom-drawer-drag-motion'

describe('bottom drawer release', () => {
  it('judges where the sheet is heading, not where the finger let go', () => {
    // 120 px down on a tall sheet stays open when released slowly, and closes when thrown.
    expect(shouldDismissBottomDrawer(120, 100, 777)).toBe(false)
    expect(shouldDismissBottomDrawer(120, 700, 777)).toBe(true)
    // A flick back up keeps the sheet even after a long drag.
    expect(shouldDismissBottomDrawer(180, -600, 777)).toBe(false)
  })

  it('leaves at the finger speed, slow or thrown, within an ordinary close', () => {
    const remaining = 825 - 112
    for (const velocity of [800, 6000, 12000]) {
      const { duration, x1, y1 } = bottomDrawerDismissMotion(112, velocity, 825, 300)
      expect(duration).toBeLessThanOrEqual(300)
      // The curve's start slope (y1 / x1) times the average speed is the speed it starts at.
      expect(((y1 / x1) * remaining) / (duration / 1000)).toBeCloseTo(velocity)
    }
  })

  it('clears the dim exactly when the sheet has left the screen', () => {
    const travel = 777 + 48
    expect(bottomDrawerScrim(1, travel, 777)).toBe(1)
    expect(bottomDrawerScrim(1 - 777 / travel, travel, 777)).toBeCloseTo(0)
  })
})
