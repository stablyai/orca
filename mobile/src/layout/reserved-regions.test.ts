import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ReservedRect, ReservedRegions } from '../../modules/orca-reserved-regions/src'
import { useReservedRegions, useTopChromeOcclusions } from './reserved-regions'
import { getSideRailStrip } from './side-rail-strip'
import { topChromeSpace } from './top-chrome-space'

const native = vi.hoisted(() => ({ emit: (_regions: ReservedRegions) => {} }))
vi.mock('../../modules/orca-reserved-regions/src', () => ({
  OrcaReservedRegions: {
    addListener: (_event: string, listener: (regions: ReservedRegions) => void) => {
      native.emit = listener
    }
  }
}))

function read(regions: ReservedRegions) {
  const seen: { all?: ReservedRect[]; header?: ReservedRect[] } = {}
  function Probe() {
    seen.all = useReservedRegions().occlusions
    seen.header = useTopChromeOcclusions()
    return null
  }
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(Probe))
  })
  act(() => native.emit(regions))
  act(() => tree?.unmount())
  return seen
}

describe('top chrome occlusions', () => {
  it('keeps an iPad header below the status bar when the sidebar is folded', () => {
    // Synthetic: the left status-bar rect the folded-sidebar screenshot implies, not a measured one.
    const seen = read({
      divisions: [],
      hasFoldDivision: false,
      occlusions: [{ x: 0, y: 0, width: 32, height: 24 }]
    })
    expect(seen.header).toEqual([])
  })

  it("leaves the iPhone Duo cover screen's status column to the side rail", () => {
    const occlusions = [
      { x: 399.67, y: 29.33, width: 37, height: 37 },
      { x: 382, y: 0, width: 84, height: 174 }
    ]
    const seen = read({ divisions: [], hasFoldDivision: false, occlusions })
    expect(seen.all).toEqual(occlusions)
    expect(
      getSideRailStrip({
        windowWidth: 466,
        windowHeight: 678,
        insets: { top: 0, right: 84, bottom: 34, left: 0 },
        occlusions: seen.all ?? []
      })
    ).not.toBeNull()
  })

  it("still shares the iPhone Duo's status strip beside its camera", () => {
    const seen = read({
      divisions: [],
      hasFoldDivision: true,
      occlusions: [{ x: 535, y: 0, width: 134, height: 82 }]
    })
    expect(topChromeSpace({ x: 0, y: 0, width: 669, height: 160 }, 82, seen.header ?? [])).toEqual({
      left: 0,
      right: 134,
      minHeight: 82
    })
  })
})
