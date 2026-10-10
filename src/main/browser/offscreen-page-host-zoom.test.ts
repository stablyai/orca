import { describe, expect, it } from 'vitest'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import { hostZoomFactor, inputInPageDips } from './offscreen-page-host-zoom'

const wheel: OffscreenPageUserInput = {
  kind: 'wheel',
  x: 10,
  y: 20,
  deltaX: 0,
  deltaY: -3,
  modifiers: []
}

describe('host zoom conversions', () => {
  it('treats a page with no synced host zoom as unzoomed', () => {
    expect(hostZoomFactor(null)).toBe(1)
    expect(inputInPageDips(wheel, null)).toEqual(wheel)
  })

  it('moves pointer positions into page DIPs and leaves other input alone', () => {
    expect(inputInPageDips(wheel, { level: 1, factor: 1.5 })).toEqual({ ...wheel, x: 15, y: 30 })
    const commit: OffscreenPageUserInput = { kind: 'commit', text: 'a' }
    expect(inputInPageDips(commit, { level: 1, factor: 1.5 })).toBe(commit)
  })
})
