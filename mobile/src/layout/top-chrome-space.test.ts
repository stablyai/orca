import { describe, expect, it } from 'vitest'
import { topChromeSpace } from './top-chrome-space'

const frame = { x: 0, y: 0, width: 669, height: 88 }
describe('header sharing the Duo top status strip', () => {
  it('uses the space beside the reported top-right system region', () => {
    expect(topChromeSpace(frame, 84, [{ x: 470, y: 0, width: 199, height: 84 }])).toEqual({
      left: 0,
      right: 199,
      minHeight: 84
    })
  })
  it('handles a left region and a header offset by a sidebar independently', () => {
    expect(topChromeSpace(frame, 84, [{ x: 0, y: 0, width: 199, height: 84 }])).toEqual({
      left: 199,
      right: 0,
      minHeight: 84
    })
    expect(
      topChromeSpace({ ...frame, x: 200, width: 469 }, 84, [
        { x: 570, y: 0, width: 99, height: 84 }
      ])
    ).toEqual({ left: 0, right: 99, minHeight: 84 })
  })
  it('keeps normal safe areas for unknown, centered, full-width or crowded obstructions', () => {
    expect(topChromeSpace(frame, 84, [])).toBeNull()
    expect(topChromeSpace(frame, 84, [{ x: 300, y: 0, width: 69, height: 84 }])).toBeNull()
    expect(topChromeSpace(frame, 84, [{ x: 0, y: 0, width: 669, height: 84 }])).toBeNull()
    expect(topChromeSpace(frame, 84, [{ x: 200, y: 0, width: 469, height: 84 }])).toBeNull()
    expect(topChromeSpace(frame, 0, [{ x: 470, y: 0, width: 199, height: 84 }])).toBeNull()
  })
  it('does not collide with an additional camera region or assume an inset was not already consumed', () => {
    expect(
      topChromeSpace(frame, 84, [
        { x: 470, y: 0, width: 199, height: 84 },
        { x: 0, y: 20, width: 30, height: 30 }
      ])
    ).toEqual({ left: 30, right: 199, minHeight: 84 })
    expect(
      topChromeSpace({ ...frame, y: 84 }, 84, [{ x: 470, y: 0, width: 199, height: 84 }])
    ).toBeNull()
  })
})
