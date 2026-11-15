import { describe, expect, it, vi } from 'vitest'
import { readCaptureViewport } from './cdp-capture-scale'
import { planFullPageTiles } from './cdp-full-page-screenshot'

vi.mock('electron', () => ({ nativeImage: {} }))

describe('a full-page capture of a page taller than its pane', () => {
  it('asks for tiles no larger than the pane draws, so the first screen is not repeated', () => {
    // A 1152x682 pane on a 125% display, holding a page four panes tall (#25272).
    const viewport = readCaptureViewport(
      {
        cssContentSize: { width: 1137, height: 2728 },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1152,
          clientHeight: 682,
          scale: 1,
          zoom: 1
        },
        visualViewport: { clientWidth: 1440, clientHeight: 852.5 }
      },
      1.25
    )

    expect(viewport && planFullPageTiles(viewport)).toEqual({
      scale: 1,
      columns: [{ start: 0, length: 1137 }],
      rows: [
        { start: 0, length: 682 },
        { start: 682, length: 682 },
        { start: 1364, length: 682 },
        { start: 2046, length: 682 }
      ]
    })
  })
})
