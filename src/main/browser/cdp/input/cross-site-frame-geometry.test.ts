import { describe, expect, it } from 'vitest'
import { frameOwnerMapping, toFrame, type Point } from './cross-site-frame-geometry'

async function mapThroughOwner(
  model: Record<string, unknown>,
  points: readonly Point[]
): Promise<Point[]> {
  const { mapping } = await frameOwnerMapping(async () => ({ model }), undefined, 1)
  if (!mapping) {
    throw new Error('no mapping')
  }
  return points.map((point) => {
    const at = toFrame([mapping], point)
    return { x: Math.round(at.x * 1000) / 1000, y: Math.round(at.y * 1000) / 1000 }
  })
}

describe('cross-site frame coordinates', () => {
  it('inverts a perspective projection at all four corners and the centre', async () => {
    // A 100x100 borderless frame tilted away at its bottom edge.
    const quad = [0, 0, 100, 0, 80, 100, 20, 100]
    const mapped = await mapThroughOwner(
      { content: quad, border: quad, width: 100, height: 100 },
      // Corners clockwise, then the diagonals' crossing, which is the projected centre.
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 80, y: 100 },
        { x: 20, y: 100 },
        { x: 50, y: 62.5 }
      ]
    )
    expect(mapped).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 50, y: 50 }
    ])
  })

  it("keeps a drag past the tilted plane's horizon heading off the frame", async () => {
    const quad = [0, 0, 100, 0, 80, 100, 20, 100]
    // The frame's sides meet at (50, 250); beyond it the projection would flip to the top.
    const ys = (
      await mapThroughOwner({ content: quad, border: quad, width: 100, height: 100 }, [
        { x: 50, y: 240 },
        { x: 50, y: 250 },
        { x: 50, y: 260 }
      ])
    ).map((point) => point.y)
    expect(ys.every((y) => Number.isFinite(y) && y > 100)).toBe(true)
    expect(ys[1]).toBeGreaterThan(ys[0])
    expect(ys[2]).toBeGreaterThanOrEqual(ys[1])
  })

  it('starts the frame at the content box of a rotated, bordered owner', async () => {
    // 120x80 border box rotated 90° clockwise about its top-left at (200, 50), with a 10px border.
    const mapped = await mapThroughOwner(
      {
        border: [200, 50, 200, 170, 120, 170, 120, 50],
        content: [190, 60, 190, 160, 130, 160, 130, 60],
        width: 120,
        height: 80
      },
      [
        { x: 190, y: 60 },
        { x: 130, y: 160 }
      ]
    )
    expect(mapped).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 60 }
    ])
  })
})
