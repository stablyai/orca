/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). Probe of the PROTOTYPE per-resource rate-limit rule
 * (rate-limit-d3.ts) against a simulated github.com account. Pure; injected clock.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createRateLimitState, type Budget, type ProbeResult, type Resource } from './rate-limit-d3'

const out: Record<string, unknown> = {}
const HOUR = 3_600_000

/** A fake account: hourly windows per resource, each with its own phase, and real usage. */
function server(startMs: number, limits: Record<Resource, number>, phaseMin: Record<Resource, number>) {
  const used: Record<string, number> = {}
  const windowOf = (r: Resource, t: number): number => Math.floor((t - phaseMin[r] * 60_000) / HOUR)
  const budget = (r: Resource, t: number): Budget => ({
    limit: limits[r],
    remaining: Math.max(0, limits[r] - (used[`${r}:${windowOf(r, t)}`] ?? 0)),
    resetAt: Math.floor(((windowOf(r, t) + 1) * HOUR + phaseMin[r] * 60_000) / 1000)
  })
  return {
    spend: (r: Resource, t: number, n = 1): void => {
      used[`${r}:${windowOf(r, t)}`] = (used[`${r}:${windowOf(r, t)}`] ?? 0) + n
    },
    budget,
    probe: (t: number): ProbeResult => ({ ok: true, resources: { core: budget('core', t), graphql: budget('graphql', t), search: budget('search', t) } }),
    start: startMs
  }
}

const T0 = Date.parse('2026-11-12T10:00:00Z')
const LIMITS = { core: 5000, graphql: 5000, search: 30 }
const PHASE = { core: 0, graphql: 20, search: 0 }

function scenario(policy: 'today' | 'd2' | 'd3', run: (ctx: { s: ReturnType<typeof createRateLimitState>; srv: ReturnType<typeof server>; at: (ms: number) => void; now: () => number; failProbes: { on: boolean } }) => unknown) {
  let now = T0
  const srv = server(T0, LIMITS, PHASE)
  const failProbes = { on: false }
  const s = createRateLimitState(policy, () => now, () => (failProbes.on ? { ok: false } : srv.probe(now)))
  const extra = run({ s, srv, at: (ms) => { now = T0 + ms }, now: () => now, failProbes })
  return { ...s.stats, ...(extra as object) }
}

it("D2-4 (Neil's case): an expired graphql window, then only headerless reads while another client burns the budget", () => {
  const r = Object.fromEntries(
    (['today', 'd2', 'd3'] as const).map((policy) => [
      policy,
      scenario(policy, ({ s, srv, at, now }) => {
        // t=0: one header-bearing REST read creates the scope (core only) and a graphql header read.
        at(0)
        s.headerBackgroundRead('core', srv.budget('core', now()))
        s.headerBackgroundRead('graphql', srv.budget('graphql', now()))
        // 25 min later the graphql window (phase :20) has rolled over. Another tool has used
        // all but 60 of the new window. Orca now makes 100 headerless graphql reads, 20 s apart.
        at(25 * 60_000)
        srv.spend('graphql', now(), LIMITS.graphql - 60)
        let admittedAfterRollover = 0
        for (let i = 0; i < 100; i++) {
          at(25 * 60_000 + i * 20_000)
          if (s.headerlessBackgroundRead('graphql') === 'admitted') {
            admittedAfterRollover += 1
            srv.spend('graphql', now())
          }
        }
        return { admittedAfterRollover, serverRemainingAtEnd: srv.budget('graphql', now()).remaining }
      })
    ])
  )
  out['d2-4 expired resource + headerless reads'] = r
  const d3 = r.d3 as { admittedAfterRollover: number; probes: number; serverRemainingAtEnd: number }
  const d2 = r.d2 as { admittedAfterRollover: number; probes: number; serverRemainingAtEnd: number }
  expect(d2.admittedAfterRollover).toBe(100) // the D2 text: no floor after rollover
  expect(d2.serverRemainingAtEnd).toBe(0)
  expect(d3.admittedAfterRollover).toBe(11) // 60 -> 49, then the floor (50) holds
  expect(d3.probes).toBe(1)
  expect(d3.serverRemainingAtEnd).toBe(49)
})

it('D2-4 mixed resources: core is fresh from headers, graphql was never observed', () => {
  const r = Object.fromEntries(
    (['d2', 'd3'] as const).map((policy) => [
      policy,
      scenario(policy, ({ s, srv, at, now }) => {
        at(0)
        srv.spend('core', now(), 100)
        s.headerBackgroundRead('core', srv.budget('core', now()))
        srv.spend('graphql', now(), LIMITS.graphql - 55)
        const results: string[] = []
        for (let i = 0; i < 20; i++) {
          at(i * 20_000)
          const d = s.headerlessBackgroundRead('graphql')
          if (d === 'admitted') srv.spend('graphql', now())
          results.push(d)
        }
        return { admitted: results.filter((x) => x === 'admitted').length, coreRemainingKept: s.state.get('core')?.remaining }
      })
    ])
  )
  out['d2-4 mixed: fresh core, unknown graphql'] = r
  expect((r.d3 as { admitted: number }).admitted).toBe(6)
  expect((r.d3 as { probes: number }).probes).toBe(1)
  expect((r.d2 as { admitted: number }).admitted).toBe(20)
})

it('probe volume: 3 h of traffic, header-bearing only, headerless only, and mixed', () => {
  const run = (kind: 'header' | 'headerless' | 'mixed') =>
    Object.fromEntries(
      (['today', 'd2', 'd3'] as const).map((policy) => [
        policy,
        scenario(policy, ({ s, srv, at, now }) => {
          for (let i = 0; i < 540; i++) {
            at(i * 20_000) // one background read every 20 s for 3 h
            const headerless = kind === 'headerless' || (kind === 'mixed' && i % 3 === 0)
            const d = headerless ? s.headerlessBackgroundRead('graphql') : s.headerBackgroundRead('graphql', srv.budget('graphql', now()))
            if (d === 'admitted') srv.spend('graphql', now())
          }
          return {}
        })
      ])
    )
  const r = { headerBearingOnly: run('header'), headerlessOnly: run('headerless'), mixed: run('mixed') }
  out['probe volume over 3 h (540 reads)'] = r
  const probes = (x: Record<string, unknown>, p: string): number => (x[p] as { probes: number }).probes
  expect(probes(r.headerBearingOnly, 'd3')).toBe(0)
  expect(probes(r.headerlessOnly, 'd3')).toBeLessThanOrEqual(4) // cold start + one per graphql window
  expect(probes(r.mixed, 'd3')).toBeLessThanOrEqual(4)
})

it('refresh failure fails open and is retried at most once per 60 s; stale observations are fenced', () => {
  const r = scenario('d3', ({ s, srv, at, now, failProbes }) => {
    failProbes.on = true
    let admitted = 0
    for (let i = 0; i < 30; i++) {
      at(i * 10_000) // 5 minutes, a read every 10 s, every refresh attempt fails
      if (s.headerlessBackgroundRead('graphql') === 'admitted') admitted += 1
    }
    const probesWhileFailing = s.stats.probes
    failProbes.on = false
    at(6 * 60_000)
    s.headerlessBackgroundRead('graphql')
    const knownAfterRecovery = s.state.get('graphql')?.limit
    // A late reply that started before an account switch must not install anything.
    const epoch = s.credentialEpoch()
    s.credentialsChanged()
    s.lateObservation('graphql', srv.budget('graphql', now()), epoch)
    const afterSwitch = s.state.get('graphql') ?? null
    // An older-window response must not replace a newer window; same window keeps the minimum.
    s.lateObservation('graphql', { limit: 5000, remaining: 4000, resetAt: 2_000_000_000 }, s.credentialEpoch())
    s.lateObservation('graphql', { limit: 5000, remaining: 4900, resetAt: 1_999_990_000 }, s.credentialEpoch())
    s.lateObservation('graphql', { limit: 5000, remaining: 4500, resetAt: 2_000_000_002 }, s.credentialEpoch())
    const ordered = s.state.get('graphql')
    return { admittedWhileFailing: admitted, probesWhileFailing, knownAfterRecovery, afterSwitch, orderedRemaining: ordered?.remaining, orderedResetAt: ordered?.resetAt }
  })
  out['refresh failure, credential switch, ordering'] = r
  expect(r).toMatchObject({ admittedWhileFailing: 30, probesWhileFailing: 5, knownAfterRecovery: 5000, afterSwitch: null, orderedRemaining: 4000, orderedResetAt: 2_000_000_000 })
})

it('write results', () => {
  const dir = process.env.EXP_OUT_DIR ?? path.resolve(__dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'rate-limit-d3.probe.json'), JSON.stringify(out, null, 2))
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out))
})
