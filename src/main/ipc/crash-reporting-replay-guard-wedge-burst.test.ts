import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from '../crash-reporting/crash-breadcrumb-store'
import { recordRendererBreadcrumbFromRenderer } from './crash-reporting-renderer-breadcrumbs'

type SpanOptions = { attributes: Record<string, unknown> }
const startSpanMock = vi.fn((_name: string, _options: SpanOptions) => ({ end: () => {} }))
vi.mock('../observability/tracer', () => ({
  startSpan: (name: string, options: SpanOptions) => startSpanMock(name, options)
}))

const WEDGE_BREADCRUMB = 'terminal_replay_guard_wedged_release'

/** Reattach-path shape: identity-bearing (`tabIdHash`, optionally `ptyId`). */
function emitReattachWedge(pane: number, withPtyId = false): void {
  recordRendererBreadcrumbFromRenderer({
    name: WEDGE_BREADCRUMB,
    data: {
      paneId: pane,
      leafIdHash: `leaf${String(pane).padStart(5, '0')}`,
      tabIdHash: `tab${String(pane).padStart(6, '0')}`,
      worktreeIdHash: 'caa15fa9',
      ...(withPtyId ? { ptyId: `…@@pty-${pane}` } : {})
    }
  })
}

/** Restore-path shape (restoreScrollbackBuffers): no tabIdHash, no ptyId. */
function emitRestoreWedge(pane: number): void {
  recordRendererBreadcrumbFromRenderer({
    name: WEDGE_BREADCRUMB,
    data: { paneId: pane, leafIdHash: `leaf${String(pane).padStart(5, '0')}` }
  })
}

function wedgeCrumbs(): ReturnType<typeof getCrashBreadcrumbSnapshot> {
  return getCrashBreadcrumbSnapshot().filter((entry) => entry.name === WEDGE_BREADCRUMB)
}

function wedgeSpanCount(): number {
  return startSpanMock.mock.calls.filter(
    (call) => call[1].attributes['breadcrumb.name'] === WEDGE_BREADCRUMB
  ).length
}

beforeEach(() => {
  startSpanMock.mockClear()
})

afterEach(() => {
  clearCrashBreadcrumbsForTest()
})

// Field spans show simultaneous replay wedges; bound the ring hazard while preserving durable per-event evidence.
describe('replay-guard wedge burst against the fixed-size breadcrumb ring', () => {
  it('costs one ring slot per call site and preserves the pre-crash trail', () => {
    for (let index = 0; index < 10; index += 1) {
      recordCrashBreadcrumb(`pre_crash_evidence_${index}`, { index })
    }

    for (let pane = 0; pane < 26; pane += 1) {
      emitReattachWedge(pane)
    }

    const snapshot = getCrashBreadcrumbSnapshot()
    expect(snapshot.filter((entry) => entry.name.startsWith('pre_crash_evidence_'))).toHaveLength(
      10
    )
    expect(wedgeCrumbs()).toHaveLength(1)
  })

  it('carries the burst multiplicity into the ring as suppressedSinceLast', () => {
    for (let pane = 0; pane < 26; pane += 1) {
      emitReattachWedge(pane)
    }

    expect(wedgeCrumbs()[0]?.data?.suppressedSinceLast).toBe(25)
  })

  // Restarts clear the ring; retain one durable span for every wedge event.
  it('still emits one durable span per wedge event', () => {
    for (let pane = 0; pane < 26; pane += 1) {
      emitReattachWedge(pane)
    }

    expect(wedgeSpanCount()).toBe(26)
    expect(
      startSpanMock.mock.calls.some((call) =>
        JSON.stringify(call[1]).includes('suppressedSinceLast')
      )
    ).toBe(false)
  })

  // Mixed restore/reattach bursts must retain both call-site shapes (bundle 8907a508).
  it('keeps restore-path and reattach-path call sites in separate slots', () => {
    emitRestoreWedge(1)
    emitRestoreWedge(2)
    emitReattachWedge(3)
    emitReattachWedge(4, true)

    const crumbs = wedgeCrumbs()
    expect(crumbs).toHaveLength(3)
    expect(crumbs.map((crumb) => Boolean(crumb.data?.tabIdHash))).toEqual([false, true, true])
    expect(crumbs.map((crumb) => Boolean(crumb.data?.ptyId))).toEqual([false, false, true])
  })

  it('bounds a many-pane burst to one slot within a call site', () => {
    for (let pane = 0; pane < 40; pane += 1) {
      emitReattachWedge(pane, pane % 2 === 0)
    }

    expect(wedgeCrumbs()).toHaveLength(2)
  })
})
