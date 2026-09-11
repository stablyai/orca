/** @vitest-environment happy-dom */
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installHappyDomOffscreenCanvasCompatibility } from './happy-dom-offscreen-canvas'

type TestOffscreenCanvas = new (
  width: number,
  height: number
) => {
  getContext: (contextType: string, contextAttributes?: unknown) => unknown
}

const openTerminals: Terminal[] = []

describe('happy-dom OffscreenCanvas compatibility', () => {
  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('delegates adapter-less 2D contexts to the existing HTML canvas double', () => {
    const offscreenCanvas = (globalThis as { OffscreenCanvas?: TestOffscreenCanvas })
      .OffscreenCanvas
    if (!offscreenCanvas) {
      expect(installHappyDomOffscreenCanvasCompatibility()).toBe(false)
      return
    }

    const context = { measureText: () => ({ width: 10 }) }
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)

    expect(installHappyDomOffscreenCanvasCompatibility()).toBe(true)
    expect(new offscreenCanvas(1, 1).getContext('2d')).toBe(context)
    expect(getContext).toHaveBeenCalled()
  })

  it('does not turn unsupported non-2D contexts into test doubles', () => {
    const offscreenCanvas = (globalThis as { OffscreenCanvas?: TestOffscreenCanvas })
      .OffscreenCanvas
    if (!offscreenCanvas) {
      return
    }

    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    expect(new offscreenCanvas(1, 1).getContext('webgl')).toBeNull()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('keeps xterm DOM rendering open with the existing HTML canvas double', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
    const host = document.createElement('div')
    document.body.append(host)
    const terminal = new Terminal()
    openTerminals.push(terminal)

    terminal.open(host)

    expect(terminal.element).not.toBeNull()
  })
})
