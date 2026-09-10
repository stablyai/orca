import { describe, expect, it } from 'vitest'
import { ptyHoldsRecordedSurface, type PtySurfaceTopology } from './pty-recorded-surface-topology'

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'

function pty(overrides: Partial<Parameters<typeof ptyHoldsRecordedSurface>[0]> = {}) {
  return {
    ptyId: 'pty-1',
    tabId: TAB,
    paneKey: `${TAB}:${LEAF}`,
    surfaceRecordedAtGraphSequence: 0,
    ...overrides
  }
}

function topology(overrides: Partial<PtySurfaceTopology> = {}): PtySurfaceTopology {
  return {
    graphSequence: 1,
    ptyIdHoldingPane: () => 'pty-1',
    ...overrides
  }
}

describe('ptyHoldsRecordedSurface', () => {
  it('holds the surface when the graph binds the recorded pane to this PTY', () => {
    expect(ptyHoldsRecordedSurface(pty(), topology())).toBe(true)
  })

  it('does not hold it when the graph has no such pane', () => {
    // #18191: the record is self-consistent, so the incumbent check said "attached" forever.
    expect(ptyHoldsRecordedSurface(pty(), topology({ ptyIdHoldingPane: () => undefined }))).toBe(
      false
    )
  })

  it('does not hold it when the graph rebound that pane to another PTY', () => {
    expect(ptyHoldsRecordedSurface(pty(), topology({ ptyIdHoldingPane: () => 'pty-2' }))).toBe(
      false
    )
  })

  it('keeps every pane attached when a lost graph empties the leaf map', () => {
    // Losing the graph clears every leaf without advancing the sequence, so the panes it held
    // keep a current stamp. Reading that emptiness as absence would orphan them all at once.
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 4 }),
        topology({ graphSequence: 4, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(true)
  })

  it('keeps naming a pane already observed dropped after the graph goes away', () => {
    // Losing the ability to re-check is not a reason to un-see the drop.
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 3 }),
        topology({ graphSequence: 4, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(false)
  })

  it('keeps a surface recorded since the last graph statement', () => {
    // Spawn records the pane before the graph carrying it arrives (#7587); the only graph that
    // has spoken since was already in flight, so its silence is not a retraction.
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 1 }),
        topology({ graphSequence: 1, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(true)
  })

  it('contradicts a surface once a later graph statement omits it', () => {
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 1 }),
        topology({ graphSequence: 2, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(false)
  })

  it('reports no surface when the record never named a pane', () => {
    expect(ptyHoldsRecordedSurface(pty({ tabId: null, paneKey: null }), topology())).toBe(false)
  })

  it('reports no surface when the record disagrees with itself', () => {
    expect(ptyHoldsRecordedSurface(pty({ paneKey: `other-tab:${LEAF}` }), topology())).toBe(false)
  })
})
