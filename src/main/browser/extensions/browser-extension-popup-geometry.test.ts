import { describe, expect, it } from 'vitest'
import {
  anchorToScreen,
  clampBrowserExtensionPopupSize,
  placeBrowserExtensionPopup
} from './browser-extension-popup-geometry'

const workArea = { x: 0, y: 25, width: 1440, height: 875 }

describe('action popup size', () => {
  it.each([
    [
      { width: 360, height: 600 },
      { width: 360, height: 600 }
    ],
    [
      { width: 10, height: 0 },
      { width: 25, height: 25 }
    ],
    [
      { width: 2000, height: 1200 },
      { width: 800, height: 600 }
    ],
    [
      { width: Number.NaN, height: 300.6 },
      { width: 25, height: 301 }
    ]
  ])('fits %j into Chrome limits as %j', (preferred, expected) => {
    expect(clampBrowserExtensionPopupSize(preferred)).toEqual(expected)
  })
})

describe('action popup placement', () => {
  it('maps a CSS-pixel button rect to the screen through the window and zoom', () => {
    expect(
      anchorToScreen(
        { x: 100, y: 40, width: 28, height: 28 },
        { x: 200, y: 75, width: 1200, height: 800 },
        1.25
      )
    ).toEqual({ x: 325, y: 125, width: 35, height: 35 })
  })

  it('sits under the button with right edges aligned', () => {
    const anchor = { x: 1000, y: 100, width: 28, height: 28 }
    expect(placeBrowserExtensionPopup(anchor, { width: 360, height: 500 }, workArea)).toEqual({
      x: 668,
      y: 130,
      width: 360,
      height: 500
    })
  })

  it('stays inside the work area near its left edge', () => {
    const anchor = { x: 10, y: 100, width: 28, height: 28 }
    expect(placeBrowserExtensionPopup(anchor, { width: 360, height: 300 }, workArea).x).toBe(0)
  })

  it('flips above the button when there is no room below', () => {
    const anchor = { x: 1000, y: 800, width: 28, height: 28 }
    expect(placeBrowserExtensionPopup(anchor, { width: 300, height: 400 }, workArea).y).toBe(398)
  })

  it('clamps to the work area when it fits neither above nor below', () => {
    const anchor = { x: 1000, y: 300, width: 28, height: 28 }
    expect(placeBrowserExtensionPopup(anchor, { width: 300, height: 600 }, workArea).y).toBe(300)
  })
})
