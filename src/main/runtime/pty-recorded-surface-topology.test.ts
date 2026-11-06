import { describe, expect, it } from 'vitest'
import {
  ptyHoldsRecordedSurface as holdsPane,
  type PtySurfaceTopology,
  type RecordedPtySurface
} from './terminal/surface/pty-recorded-surface-topology'

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'

type Recorded = RecordedPtySurface & { tabId: string | null; paneKey: string | null }

/** The pane the record names, as the window-owned query reads it. */
function ptyHoldsRecordedSurface(record: Recorded, graph: PtySurfaceTopology): boolean {
  return holdsPane(
    record.ptyId,
    {
      tabId: record.tabId,
      paneKey: record.paneKey,
      recordedAtGraphSequence: record.surfaceRecordedAtGraphSequence ?? 0
    },
    graph
  )
}

function pty(overrides: Partial<Recorded> = {}): Recorded {
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
    expect(ptyHoldsRecordedSurface(pty(), topology({ ptyIdHoldingPane: () => undefined }))).toBe(
      false
    )
  })

  it('does not hold it when the graph rebound that pane to another PTY', () => {
    expect(ptyHoldsRecordedSurface(pty(), topology({ ptyIdHoldingPane: () => 'pty-2' }))).toBe(
      false
    )
  })

  it('keeps a surface recorded since the last graph statement', () => {
    // Spawn precedes graph publication; an already in-flight graph cannot retract its new pane (#7587).
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
