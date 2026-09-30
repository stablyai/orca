import { describe, expect, it } from 'vitest'
import { cssCursorForPage } from './offscreen-page-cursor'

describe('cssCursorForPage', () => {
  it('maps Electron cursor names to the CSS cursor Chromium shows', () => {
    expect(cssCursorForPage('pointer')).toBe('default')
    expect(cssCursorForPage('hand')).toBe('pointer')
    expect(cssCursorForPage('text')).toBe('text')
    expect(cssCursorForPage('nwse-resize')).toBe('nwse-resize')
    expect(cssCursorForPage('ne-panning')).toBe('ne-resize')
    expect(cssCursorForPage('nodrop')).toBe('no-drop')
    expect(cssCursorForPage('something-new')).toBe('default')
  })

  it('draws a page cursor image at its scale with the hotspot in CSS px', () => {
    const image = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every NativeImage member the mapping reads.
    expect(cssCursorForPage('custom', image as never, 2, { x: 8, y: 4 })).toBe(
      'image-set(url("data:image/png;base64,AAAA") 2x) 4 2, default'
    )
  })
})
