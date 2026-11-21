import { describe, expect, it } from 'vitest'
import { clearHudCanvas, GLASSES_HEIGHT, GLASSES_WIDTH } from './glasses-canvas-preview'

function makeFakeCtx(): { fillStyle: string; calls: string[] } & Pick<
  CanvasRenderingContext2D,
  'fillRect'
> {
  const ctx = {
    fillStyle: '',
    calls: [] as string[],
    fillRect(x: number, y: number, w: number, h: number) {
      ctx.calls.push(`fillRect(${x},${y},${w},${h})`)
    }
  }
  return ctx
}

describe('clearHudCanvas', () => {
  it('fills the full glasses-sized rect with black', () => {
    const ctx = makeFakeCtx()
    clearHudCanvas(ctx as unknown as CanvasRenderingContext2D)
    expect(ctx.fillStyle).toBe('#000000')
    expect(ctx.calls).toEqual([`fillRect(0,0,${GLASSES_WIDTH},${GLASSES_HEIGHT})`])
  })
})
