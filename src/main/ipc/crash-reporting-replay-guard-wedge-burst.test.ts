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

// One mount/reveal/wake transition expires every in-flight replay write at once, so
// the burst reaches the 30-slot ring as N distinct entries. Field span streams measure
// bursts of 26 in 0.96s and 62 over 85s. No captured report in the 09-02 corpus shows
// a ring that actually drained — all nine bursts predate their report's ring window —
// so this bounds a demonstrated hazard, not an observed loss, and must not cost the
// durable span evidence that did carry those bursts.
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

    // 26 emissions: one owns the slot, 25 fold into it.
    expect(wedgeCrumbs()[0]?.data?.suppressedSinceLast).toBe(25)
  })

  // The 121-event field corpus lives entirely in the renderer.breadcrumb span stream,
  // and the ring is cleared by the restart that usually precedes the crash report, so
  // ring coalescing must not suppress the per-event spans.
  it('still emits one durable span per wedge event', () => {
    for (let pane = 0; pane < 26; pane += 1) {
      emitReattachWedge(pane)
    }

    expect(wedgeSpanCount()).toBe(26)
    // Why no count on the span: one span per event already carries the multiplicity.
    expect(
      startSpanMock.mock.calls.some((call) =>
        JSON.stringify(call[1]).includes('suppressedSinceLast')
      )
    ).toBe(false)
  })

  // Bundle 8907a508 mixes restore-path (identity-less) and reattach-path crumbs in one
  // window; name-only keying would report only the last one's shape.
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
