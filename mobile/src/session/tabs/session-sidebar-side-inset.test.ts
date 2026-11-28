import { describe, expect, it } from 'vitest'
import { sessionSidebarSidePadding } from './session-sidebar-side-inset'

describe('sessionSidebarSidePadding', () => {
  it('returns null when SideSafeArea already pads both sides (phones, tablets, non-released Duo)', () => {
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 44, right: 44 },
        windowWidth: 844,
        frameWidth: 756,
        docked: false,
        sidebarPeek: 80
      })
    ).toBeNull()
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 0, right: 0 },
        windowWidth: 1366,
        frameWidth: 1366,
        docked: true,
        sidebarPeek: 80
      })
    ).toBeNull()
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 0, right: 84 },
        windowWidth: 466,
        frameWidth: 382,
        docked: false,
        sidebarPeek: 80
      })
    ).toBeNull()
  })

  it('pads the right side by the released Duo status column on folded and unfolded sessions', () => {
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 0, right: 84 },
        windowWidth: 466,
        frameWidth: 466,
        docked: false,
        sidebarPeek: 80
      })
    ).toEqual({ paddingRight: 84 })
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 0, right: 84 },
        windowWidth: 951,
        frameWidth: 951,
        docked: false,
        sidebarPeek: 80
      })
    ).toEqual({ paddingRight: 84 })
  })

  it('only pads left-side overflow past SIDEBAR_PEEK when rotated', () => {
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 84, right: 0 },
        windowWidth: 466,
        frameWidth: 466,
        docked: false,
        sidebarPeek: 80
      })
    ).toEqual({ paddingLeft: 4 })
    expect(
      sessionSidebarSidePadding({
        windowInsets: { left: 84, right: 0 },
        windowWidth: 951,
        frameWidth: 951,
        docked: true,
        sidebarPeek: 80
      })
    ).toBeNull()
  })
})
