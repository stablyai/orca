import { describe, expect, it } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import {
  ptyHoldsRecordedSurface as holdsPane,
  recordPtySurface,
  type PtySurfaceTopology,
  type RecordedPtySurface
} from './pty-recorded-surface-topology'

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

  it('keeps every pane attached when a lost graph empties the leaf map', () => {
    // Lost graphs clear leaves without advancing sequence; that emptiness cannot contradict prior claims.
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 4 }),
        topology({ graphSequence: 4, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(true)
  })

  it('keeps naming a pane already observed dropped after the graph goes away', () => {
    // An unavailable graph must not undo an already witnessed drop.
    expect(
      ptyHoldsRecordedSurface(
        pty({ surfaceRecordedAtGraphSequence: 3 }),
        topology({ graphSequence: 4, ptyIdHoldingPane: () => undefined })
      )
    ).toBe(false)
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

  it('re-attaches a contradicted record once a claim re-records its surface', () => {
    // Adoption, split and TUI recovery also claim panes before the graph can witness them.
    const record = pty({ surfaceRecordedAtGraphSequence: 1 })
    const graph = topology({ graphSequence: 3, ptyIdHoldingPane: () => undefined })
    expect(ptyHoldsRecordedSurface(record, graph)).toBe(false)

    recordPtySurface(record, TAB, `${TAB}:${LEAF}`, graph.graphSequence)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(record.surfaceRecordedAtGraphSequence).toBe(1)
      return
    }
    expect(ptyHoldsRecordedSurface(record, graph)).toBe(true)
    expect(ptyHoldsRecordedSurface(record, { ...graph, graphSequence: 4 })).toBe(false)
  })

  it('reports no surface when the record never named a pane', () => {
    expect(ptyHoldsRecordedSurface(pty({ tabId: null, paneKey: null }), topology())).toBe(false)
  })

  it('reports no surface when the record disagrees with itself', () => {
    expect(ptyHoldsRecordedSurface(pty({ paneKey: `other-tab:${LEAF}` }), topology())).toBe(false)
  })
})
