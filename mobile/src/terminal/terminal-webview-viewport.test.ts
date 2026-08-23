import { Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_VIEWPORT_JS } from './terminal-webview-viewport-injected'

function createViewportHarness() {
  let mediaListener = () => {}
  const notify = vi.fn()
  const applyFitScale = vi.fn()
  const context = {
    applyFitScale,
    attachWebglAddon: vi.fn(),
    clampPan: vi.fn(),
    notify,
    term: null,
    updateTransform: vi.fn(),
    webglAddon: null,
    window: {
      devicePixelRatio: 1,
      innerHeight: 1080,
      innerWidth: 1920,
      matchMedia: vi.fn(() => ({
        addEventListener: (_type: string, listener: () => void) => {
          mediaListener = listener
        },
        removeEventListener: vi.fn()
      }))
    }
  }
  new Script(`${TERMINAL_VIEWPORT_JS}
this.setViewport = setRnViewport;
this.getWidth = getViewportWidth;
this.getHeight = getViewportHeight;
`).runInNewContext(context)
  return {
    applyFitScale,
    fireDprChange: () => mediaListener(),
    getHeight: (context as { getHeight: () => number }).getHeight,
    getWidth: (context as { getWidth: () => number }).getWidth,
    notify,
    setViewport: (context as { setViewport: (width: number, height: number) => void }).setViewport
  }
}

describe('terminal WebView viewport bridge', () => {
  it('prefers RN root bounds over display-sized WebView fallbacks', () => {
    const harness = createViewportHarness()
    harness.setViewport(800, 600)
    expect(harness.getWidth()).toBe(800)
    expect(harness.getHeight()).toBe(600)
  })

  it('re-fits and reports viewport state when DPR changes', () => {
    const harness = createViewportHarness()
    harness.fireDprChange()
    expect(harness.applyFitScale).toHaveBeenCalledWith('dpr')
    expect(harness.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'viewport-changed', dpr: 1 })
    )
  })
})
