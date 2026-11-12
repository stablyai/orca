/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). Policy probes: the real check classifier from
 * src/shared feeds the D3 policy module. Covers D2-3 (complete-empty rollups) and the fixed
 * 10/60 min caps (PD-1 = option C; the D3 caps 30/60 are checked as a named comparison). Pure; fake clock only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { classifyPRCheckRollupResult, summarizePRCheckRollup, derivePRCheckStatusFromRollup } from '../../../shared/source-control/checks/pr-check-status'
import * as policy from './policy-d3'

const out: Record<string, unknown> = {}
const T = Date.parse('2026-11-12T10:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
  policy.backoff.clear()
})
afterEach(() => vi.useRealTimers())

const run = (name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({ __typename: 'CheckRun', name, status, conclusion, ...extra })
const ROLLUPS: Record<string, { rollup: unknown[]; readComplete: boolean; expectRunning: boolean }> = {
  'complete, empty (no CI)': { rollup: [], readComplete: true, expectRunning: false },
  'incomplete, empty (partial read)': { rollup: [], readComplete: false, expectRunning: true },
  'complete, all passed': { rollup: [run('build', 'COMPLETED', 'SUCCESS'), run('test', 'COMPLETED', 'SUCCESS')], readComplete: true, expectRunning: false },
  'complete, failed only': { rollup: [run('build', 'COMPLETED', 'FAILURE')], readComplete: true, expectRunning: false },
  'failed + running': { rollup: [run('lint', 'COMPLETED', 'FAILURE'), run('build', 'IN_PROGRESS', null)], readComplete: true, expectRunning: true },
  'queued only': { rollup: [run('build', 'QUEUED', null)], readComplete: true, expectRunning: true },
  'awaiting approval': { rollup: [run('build', 'COMPLETED', 'SUCCESS'), { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED', pendingApproval: true }], readComplete: true, expectRunning: true },
  'incomplete, passed so far': { rollup: [run('build', 'COMPLETED', 'SUCCESS')], readComplete: false, expectRunning: true }
}

function outcome(state: 'open' | 'merged', rollup: unknown[], readComplete: boolean) {
  const result = classifyPRCheckRollupResult(rollup, readComplete)
  return {
    kind: 'found',
    pr: {
      number: 1,
      state,
      headSha: 'a'.repeat(40),
      checksStatus: derivePRCheckStatusFromRollup(rollup),
      checksSummary: summarizePRCheckRollup(rollup),
      checksFinal: result.final,
      checksReadComplete: readComplete,
      failingCheckNames: result.failingCheckNames,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      updatedAt: '2026-11-10T00:00:00Z'
    }
  }
}

const min = (ms: number): number | 'none' => (Number.isFinite(ms) ? +(ms / 60_000).toFixed(2) : 'none')

it('D2-3: activity classes from the real classifier, and the interval after 10 unchanged reads', () => {
  const rows: Record<string, unknown> = {}
  for (const [name, r] of Object.entries(ROLLUPS)) {
    for (const state of ['open', 'merged'] as const) {
      policy.backoff.clear()
      const o = outcome(state, r.rollup, r.readComplete)
      for (let i = 0; i <= 10; i++) policy.note('k', o)
      const d = policy.describe(o)
      rows[`${name} / ${state}`] = {
        checksFinal: o.pr.checksFinal,
        total: o.pr.checksSummary.total,
        pending: o.pr.checksSummary.pending,
        checksStatus: o.pr.checksStatus,
        activity: d.activity,
        running: d.running,
        selectedIntervalMin: min(policy.interval('k', true, T, 0)),
        visibleIntervalMin: min(policy.interval('k', false, T, 0))
      }
      expect(d.running, `${name} / ${state}`).toBe(r.expectRunning)
    }
  }
  out['d2-3 activity and interval after 10 unchanged reads'] = rows
  const r = rows as Record<string, { selectedIntervalMin: number | 'none'; visibleIntervalMin: number | 'none' }>
  expect(r['complete, empty (no CI) / open']).toMatchObject({ selectedIntervalMin: 10, visibleIntervalMin: 60 })
  expect(r['complete, empty (no CI) / merged']).toMatchObject({ selectedIntervalMin: 'none', visibleIntervalMin: 'none' })
  expect(r['failed + running / open']).toMatchObject({ selectedIntervalMin: 1, visibleIntervalMin: 2 })
  expect(r['awaiting approval / open']).toMatchObject({ selectedIntervalMin: 1 })
  expect(r['incomplete, empty (partial read) / merged']).toMatchObject({ selectedIntervalMin: 1 })
})

it('fixed caps: the backoff ladder for an unchanged settled row, and resets', () => {
  const settled = outcome('open', ROLLUPS['complete, all passed'].rollup, true)
  const ladder = (selected: boolean): (number | 'none')[] => {
    policy.backoff.clear()
    const steps: (number | 'none')[] = []
    for (let i = 0; i < 9; i++) {
      policy.note('k', settled)
      steps.push(min(policy.interval('k', selected, T, 0)))
    }
    return steps
  }
  const selected = ladder(true)
  const visible = ladder(false)
  // A change of what is shown resets the ladder; so does an explicit reset (selection, manual, push).
  policy.note('k', outcome('open', ROLLUPS['failed + running'].rollup, true))
  const afterChange = min(policy.interval('k', false, T, 0))
  policy.note('k', settled)
  policy.note('k', settled)
  policy.note('k', settled)
  const before = min(policy.interval('k', true, T, 0))
  policy.reset('k')
  const afterReset = min(policy.interval('k', true, T, 0))
  // Jitter never lengthens.
  let maxJittered = 0
  for (let a = 0; a < 500; a++) maxJittered = Math.max(maxJittered, policy.interval('k', true, T + a, 0.1))
  policy.backoff.clear()
  const noPR = [0, 1, 2, 3].map(() => {
    policy.note('n', { kind: 'not-found' })
    return [min(policy.interval('n', true, T, 0)), min(policy.interval('n', false, T, 0))]
  })
  // Named comparison: the D3 caps (30 / 60), reproducible through setCaps.
  const defaults = [policy.POLICY_D3.SELECTED_CAP_MS / 60_000, policy.POLICY_D3.VISIBLE_CAP_MS / 60_000]
  policy.setCaps(30, 60)
  const selectedD3Caps = ladder(true)
  const visibleD3Caps = ladder(false)
  policy.setCaps(defaults[0], defaults[1])
  policy.backoff.clear()
  const r = { defaultCapsMin: defaults, selectedMinutes: selected, visibleMinutes: visible, comparisonD3Caps30_60: { selectedMinutes: selectedD3Caps, visibleMinutes: visibleD3Caps }, afterChangeVisibleMin: afterChange, selectedBeforeResetMin: before, selectedAfterResetMin: afterReset, jitterNeverLengthens: maxJittered <= 60_000, noPRSelectedVisibleMinutes: noPR }
  out['fixed caps ladder'] = r
  expect(defaults).toEqual([10, 60])
  expect(selected).toEqual([1, 2, 4, 8, 10, 10, 10, 10, 10])
  expect(selectedD3Caps).toEqual([1, 2, 4, 8, 16, 30, 30, 30, 30])
  expect(visibleD3Caps).toEqual(visible)
  expect(visible).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60])
  expect(afterChange).toBe(2)
  expect(afterReset).toBe(1)
  expect(r.jitterNeverLengthens).toBe(true)
})

it('stuck check on a non-selected row decays after 30 min; a selected row never does', () => {
  const running = outcome('open', ROLLUPS['queued only'].rollup, true)
  const at: Record<string, unknown> = {}
  for (const m of [0, 29, 31, 41, 51, 61, 71, 90, 180]) {
    vi.setSystemTime(T + m * 60_000)
    policy.note('k', running)
    at[`${m} min`] = { visibleMin: min(policy.interval('k', false, T, 0)), selectedMin: min(policy.interval('k', true, T, 0)) }
  }
  out['stuck check decay'] = at
  expect(at['29 min']).toEqual({ visibleMin: 2, selectedMin: 1 })
  expect(at['180 min']).toEqual({ visibleMin: 60, selectedMin: 1 })
})

it('write results', () => {
  const dir = process.env.EXP_OUT_DIR ?? path.resolve(__dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'policy-d3.probe.json'), JSON.stringify(out, null, 2))
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out))
})
