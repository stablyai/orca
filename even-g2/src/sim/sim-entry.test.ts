import { describe, expect, it, vi } from 'vitest'
import type { HudPageBuild } from '../glasses/glasses-bridge'
import type { GlassesCanvasPreview } from './glasses-canvas-preview'
import { renderPreviewFrame, type RepaintSource } from './sim-entry'

function makeFakePreview(): GlassesCanvasPreview & {
  paint: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  return {
    canvas: document.createElement('canvas'),
    paint: vi.fn(),
    clear: vi.fn()
  }
}

describe('renderPreviewFrame', () => {
  it('paints the current page when one exists', () => {
    const page = { containers: [] } as unknown as HudPageBuild
    const bridge: RepaintSource = { pageSnapshot: () => page, getListSelection: () => 2 }
    const preview = makeFakePreview()

    renderPreviewFrame(bridge, preview)

    expect(preview.paint).toHaveBeenCalledWith(page, { listSelectedIndex: 2 })
    expect(preview.clear).not.toHaveBeenCalled()
  })

  it('clears the preview when there is no HUD page (e.g. after a hard shutdown)', () => {
    const bridge: RepaintSource = { pageSnapshot: () => null, getListSelection: () => undefined }
    const preview = makeFakePreview()

    renderPreviewFrame(bridge, preview)

    expect(preview.clear).toHaveBeenCalledTimes(1)
    expect(preview.paint).not.toHaveBeenCalled()
  })

  it('is a no-op when preview is null (no real canvas context available)', () => {
    const bridge: RepaintSource = { pageSnapshot: () => null, getListSelection: () => undefined }
    expect(() => renderPreviewFrame(bridge, null)).not.toThrow()
  })
})
