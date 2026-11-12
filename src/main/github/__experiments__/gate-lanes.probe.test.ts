/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). Policy microprobe for the admission gate: no Orca code,
 * no timers, no subprocess. A loop advances an injected clock one second at a time and plays
 * simple callers against the D2 gate ("before") and the D3 lanes gate ("after").
 *
 * Caller model: an identity asks when it is due; admitted -> due again after its period;
 * refused -> asks again at the retry time it was given (unless it has gone away).
 * This is not the scheduler/transport path; the full harness covers that.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createGateD2, createGateD3, summarizeGate, type Gate, type GateLane } from './gate-d3'

type Caller = {
  key: string
  client: number
  lane: GateLane
  periodMs: number
  firstDueMs: number
  /** Caller stops asking at this time (disconnect / hidden window / cancelled). */
  goneAtMs?: number
}

const T0 = 1_000_000

function play(make: (now: () => number) => Gate, callers: Caller[], seconds: number) {
  let now = T0
  const gate = make(() => now)
  const state = callers.map((c) => ({ c, nextTry: T0 + c.firstDueMs, dueSince: T0 + c.firstDueMs, starts: [] as number[] }))
  // Selected callers ask first inside one tick, as in Neil's probe (worst case for visible).
  const order = [...state].sort((a, b) => Number(b.c.lane === 'selected') - Number(a.c.lane === 'selected') || (a.c.key < b.c.key ? -1 : 1))
  for (let s = 0; s <= seconds; s++) {
    now = T0 + s * 1000
    for (const st of order) {
      if (st.c.goneAtMs !== undefined && now >= T0 + st.c.goneAtMs) continue
      if (now < st.nextTry) continue
      const d = gate.request(st.c.client, st.c.key, st.c.lane, st.dueSince, true)
      if (d.admit) {
        st.starts.push(now - T0)
        st.dueSince = now + st.c.periodMs
        st.nextTry = st.dueSince
      } else {
        st.nextTry = d.retryAt
      }
    }
  }
  const perCaller = (lane: GateLane) =>
    state
      .filter((st) => st.c.lane === lane)
      .map((st) => {
        const gaps = st.starts.slice(1).map((t, i) => t - st.starts[i])
        return {
          key: st.c.key,
          starts: st.starts.length,
          firstStartS: st.starts.length ? Math.round(st.starts[0] / 1000) : null,
          maxGapS: gaps.length ? Math.round(Math.max(...gaps) / 1000) : null,
          tailWithoutStartS: Math.round((seconds * 1000 - (st.starts.at(-1) ?? st.c.firstDueMs)) / 1000)
        }
      })
  const vis = perCaller('visible')
  const sel = perCaller('selected')
  return {
    summary: summarizeGate(gate, T0, T0 + seconds * 1000),
    selected: sel,
    visible: {
      callers: vis.length,
      served: vis.filter((v) => v.starts > 0).length,
      neverServed: vis.filter((v) => v.starts === 0).length,
      allServedByS: vis.every((v) => v.firstStartS !== null) ? Math.max(0, ...vis.map((v) => v.firstStartS ?? 0)) : null,
      worstMaxGapS: Math.max(0, ...vis.map((v) => v.maxGapS ?? 0)),
      worstTailWithoutStartS: Math.max(0, ...vis.map((v) => v.tailWithoutStartS)),
      firstStartsS: vis.length <= 6 ? vis.map((v) => v.firstStartS) : undefined
    }
  }
}

const sel = (n: number, periodMs = 60_000, client0 = 1): Caller[] =>
  Array.from({ length: n }, (_, i) => ({ key: `sel-${i}`, client: client0 + i, lane: 'selected' as const, periodMs, firstDueMs: 0 }))
const vis = (n: number, periodMs: number, firstDueMs: number, client = 9, prefix = 'vis', goneAtMs?: number): Caller[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}-${String(i).padStart(3, '0')}`, client, lane: 'visible' as const, periodMs, firstDueMs, goneAtMs }))

const SCENARIOS: Record<string, { callers: Caller[]; seconds: number; what: string }> = {
  'neil-4sel-1vis': {
    what: "Neil's D2-2 probe: 4 selected identities every 60 s, 1 visible identity always due (period 120 s), 1 h",
    callers: [...sel(4), ...vis(1, 120_000, 0)],
    seconds: 3600
  },
  '4sel-50vis': {
    what: '4 selected identities every 60 s; 50 visible identities all due at minute 5, period 60 min; 2 h',
    callers: [...sel(4), ...vis(50, 60 * 60_000, 5 * 60_000)],
    seconds: 7200
  },
  '2sel-50vis': {
    what: '2 selected identities every 60 s (one PR + its Checks read); 50 visible due at minute 5, period 60 min; 2 h',
    callers: [...sel(2), ...vis(50, 60 * 60_000, 5 * 60_000)],
    seconds: 7200
  },
  '1sel-50vis-busy': {
    what: '1 selected identity every 60 s; 50 visible identities with running CI (period 120 s, permanently saturating); 1 h',
    callers: [...sel(1), ...vis(50, 120_000, 0)],
    seconds: 3600
  },
  '8sel-checks-50vis': {
    what: 'Checks demand: 4 clients, each a selected PR read and a Checks read every 60 s (8 selected identities); 50 visible due at minute 5, period 60 min; 2 h',
    callers: [...sel(8), ...vis(50, 60 * 60_000, 5 * 60_000)],
    seconds: 7200
  },
  '4sel-quiet': {
    what: '4 selected identities every 60 s and no visible demand at all (how far selected may borrow); 1 h',
    callers: sel(4),
    seconds: 3600
  },
  '0sel-200vis': {
    what: 'no selected demand; 200 visible identities all due at once, period 60 min (visible-only saturation); 2 h',
    callers: vis(200, 60 * 60_000, 0),
    seconds: 7200
  },
  'cancel-50-absent': {
    what: 'cancellation: client 9 has 50 visible identities due at 0 and disappears at 60 s (claims left behind); client 8 has 5 visible identities due at 60 s; 1 selected; 30 min',
    callers: [...sel(1), ...vis(50, 60 * 60_000, 0, 9, 'gone', 60_000), ...vis(5, 60 * 60_000, 60_000, 8, 'small')],
    seconds: 1800
  }
}

function instant(make: (now: () => number) => Gate) {
  const now = 50_000_000
  const gate = make(() => now)
  let admitted = 0
  for (let i = 0; i < 20; i++) if (gate.request(i, `sel-${i}`, 'selected', now, true).admit) admitted++
  return admitted
}

function reserved(make: (now: () => number) => Gate) {
  let now = 60_000_000
  const gate = make(() => now)
  let s = 0
  let v = 0
  for (let i = 0; i < 4; i++) if (gate.request(i, `s-${i}`, 'selected', now, true).admit) s++
  for (let i = 0; i < 16; i++) {
    now = 60_000_000 + (i + 1) * 10_000
    if (gate.request(9, `v-${i}`, 'visible', now, true).admit) v++
  }
  return { selected: s, visible: v }
}

it('gate lanes: D2 gate (before) against D3 lanes (after)', () => {
  const out: Record<string, unknown> = {}
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    out[name] = {
      what: sc.what,
      before: play(createGateD2, sc.callers, sc.seconds),
      after: play(createGateD3, sc.callers, sc.seconds),
      // Alternative split, not the proposal: 10 selected / 10 visible, no borrowing.
      alt10x10: play((now) => createGateD3(now, { SELECTED_SHARE: 10, VISIBLE_SHARE: 10, BORROW_MAX: 0 }), sc.callers, sc.seconds)
    }
  }
  out['20-selected-at-one-instant'] = { what: 'selected starts admitted at a single instant out of 20 distinct identities', before: instant(createGateD2), after: instant(createGateD3) }
  out['4-selected-then-16-visible'] = { what: "Neil's reserve probe: 4 selected at once, then 16 visible 10 s apart", before: reserved(createGateD2), after: reserved(createGateD3) }
  const dir = process.env.EXP_OUT_DIR ?? path.resolve(__dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'gate-lanes.probe.json'), JSON.stringify(out, null, 2))
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, (k, v) => (k === 'selected' && Array.isArray(v) && v.length > 8 ? undefined : v)))

  // The D3 contract, asserted (these fail on the D2 gate):
  const after = (n: string) => (out[n] as { after: ReturnType<typeof play> }).after
  for (const name of Object.keys(SCENARIOS)) {
    const a = after(name)
    expect(a.summary.budgeted.peak5min, `${name} total per 5 min`).toBeLessThanOrEqual(20)
    expect(a.summary.lanes.visible.peak5min + 0, `${name} visible per 5 min`).toBeLessThanOrEqual(15)
    expect(a.summary.selectedTotal.peak5min, `${name} selected per 5 min`).toBeLessThanOrEqual(10)
    expect(a.summary.lanes.visible.peak60s, `${name} visible per 60 s`).toBeLessThanOrEqual(6)
    expect(a.summary.budgeted.peak60s, `${name} budgeted per 60 s`).toBeLessThanOrEqual(11)
  }
  expect(after('neil-4sel-1vis').visible.worstMaxGapS).toBeLessThanOrEqual(140)
  expect(after('4sel-50vis').visible.neverServed).toBe(0)
  expect(after('8sel-checks-50vis').visible.neverServed).toBe(0)
  // 5 from the selected share plus one borrowed start (the borrowed ones are 10 s apart).
  expect(out['20-selected-at-one-instant']).toMatchObject({ after: 6 })
})
