import { describe, expect, it } from 'vitest'
import { placePullDownMenu } from './pull-down-menu-placement'

const DUO_FOLDED = { width: 466, height: 900 }
const DUO_INSETS = { top: 47, right: 84, bottom: 34, left: 0 }
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

describe('placePullDownMenu', () => {
  it('drops below a header button, scrolling before it reaches the home indicator', () => {
    const placement = placePullDownMenu({
      anchor: { x: 332, y: 26, width: 36, height: 36 },
      window: DUO_FOLDED,
      insets: DUO_INSETS
    })
    expect(placement).toEqual({ left: 116, width: 252, top: 68, maxHeight: 790 })
  })

  it('opens upward from a low button, scrolling before it reaches the status bar', () => {
    const placement = placePullDownMenu({
      anchor: { x: 332, y: 800, width: 36, height: 36 },
      window: DUO_FOLDED,
      insets: DUO_INSETS
    })
    expect(placement).toEqual({ left: 116, width: 252, bottom: 106, maxHeight: 739 })
  })

  it('stays on screen beside the left edge and the status column', () => {
    const nearLeft = placePullDownMenu({
      anchor: { x: 180, y: 26, width: 36, height: 36 },
      window: DUO_FOLDED,
      insets: DUO_INSETS
    })
    expect(nearLeft).toMatchObject({ left: 8, width: 252 })
    const inColumn = placePullDownMenu({
      anchor: { x: 420, y: 26, width: 36, height: 36 },
      window: DUO_FOLDED,
      insets: DUO_INSETS
    })
    expect(inColumn.left + inColumn.width).toBe(374)
  })

  it('narrows to a window thinner than the menu', () => {
    const placement = placePullDownMenu({
      anchor: { x: 180, y: 26, width: 36, height: 36 },
      window: { width: 220, height: 600 },
      insets: NO_INSETS
    })
    expect(placement).toMatchObject({ left: 8, width: 204 })
  })
})
