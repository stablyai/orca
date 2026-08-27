import { describe, expect, it } from 'vitest'
import {
  admitRoute,
  checkRouteEligibility,
  isExcludedWorkerAgent,
  listAdmissibleRoutes,
  selectRoute
} from './role-route-registry'
import {
  ROUTE_EVIDENCE_KINDS,
  requiredEvidenceKinds,
  resolveRouteCertification,
  type RouteEvidence
} from './route-certification-evidence'
import {
  classifyRouteFailure,
  routeKey,
  UNKNOWN,
  unknownReadiness,
  type RouteIdentity,
  type RouteRole,
  type RouteRow,
  type SessionMode
} from './route-registry-types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const SHA = 'abc1234'
const VERSION = '1.4.188'

function identity(overrides: Partial<RouteIdentity> = {}): RouteIdentity {
  return { agent: 'claude', model: 'opus[1m]', reasoning: 'high', ...overrides }
}

function route(overrides: Partial<RouteRow> = {}): RouteRow {
  return {
    identity: identity(),
    provider: 'anthropic',
    harness: 'claude-code',
    roles: ['builder', 'reviewer'],
    taskCapabilities: ['bounded_implementation', 'heavy_review'],
    sessionModes: ['fresh', 'retained'],
    reasoningModes: ['high', 'max'],
    contextLimitTokens: 1_000_000,
    costClass: 'subscription',
    identityProof: 'exact',
    launcherSupported: true,
    hookSupported: true,
    readiness: {
      availability: 'available',
      authenticated: true,
      providerStatus: 'ok',
      quota: { state: 'ok', resetAt: UNKNOWN, remainingFraction: UNKNOWN }
    },
    constraints: [],
    notes: null,
    ...overrides
  }
}

function fullEvidence(args: {
  identity: RouteIdentity
  role: RouteRole
  sessionMode: SessionMode
  observedAt?: string
  outcome?: RouteEvidence['outcome']
  commitSha?: string
}): RouteEvidence[] {
  return requiredEvidenceKinds(args.sessionMode).map((kind) => ({
    routeKey: routeKey(args.identity),
    kind,
    role: args.role,
    sessionMode: args.sessionMode,
    outcome: args.outcome ?? 'PASS',
    observedAt: args.observedAt ?? '2026-08-27T11:00:00.000Z',
    runtimeVersion: VERSION,
    commitSha: args.commitSha ?? SHA,
    detail: null
  }))
}

const baseAdmission = {
  nowMs: NOW,
  currentCommitSha: SHA,
  currentRuntimeVersion: VERSION
}

describe('B1 certification is derived from evidence, never asserted', () => {
  it('admits only a route whose required evidence is complete and current', () => {
    const row = route()
    const admission = admitRoute({
      ...baseAdmission,
      registry: [row],
      evidence: fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' }),
      requested: row.identity,
      effective: row.identity,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    })
    expect(admission.ok).toBe(true)
  })

  it('negative control: a route with no evidence is UNTESTED and refused', () => {
    const row = route()
    const admission = admitRoute({
      ...baseAdmission,
      registry: [row],
      evidence: [],
      requested: row.identity,
      effective: row.identity,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    })
    expect(admission).toMatchObject({
      ok: false,
      error: { code: 'route_untested', state: 'UNTESTED' }
    })
  })

  it('excludes a FAILed route and a STALE route from admission and from fallback', () => {
    const failing = route({ identity: identity({ model: 'sonnet-4.9' }) })
    const staleRoute = route({ identity: identity({ model: 'haiku-4.5' }) })
    const healthy = route({ identity: identity({ model: 'opus-5' }) })
    const evidence = [
      ...fullEvidence({
        identity: failing.identity,
        role: 'builder',
        sessionMode: 'fresh',
        outcome: 'FAIL'
      }),
      // Stale: evidence bound to a SHA that is no longer current.
      ...fullEvidence({
        identity: staleRoute.identity,
        role: 'builder',
        sessionMode: 'fresh',
        commitSha: 'deadbee'
      }),
      ...fullEvidence({ identity: healthy.identity, role: 'builder', sessionMode: 'fresh' })
    ]
    const admissible = listAdmissibleRoutes({
      ...baseAdmission,
      registry: [failing, staleRoute, healthy],
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    })
    expect(admissible.map((entry) => entry.identity.model)).toEqual(['opus-5'])

    expect(
      admitRoute({
        ...baseAdmission,
        registry: [staleRoute],
        evidence,
        requested: staleRoute.identity,
        effective: staleRoute.identity,
        requirement: { role: 'builder', sessionMode: 'fresh' }
      })
    ).toMatchObject({ ok: false, error: { code: 'route_stale', state: 'STALE' } })
  })

  it('reports UNSUPPORTED without demoting or ranking the route', () => {
    const row = route({ identity: identity({ model: 'glm-5.3' }) })
    const evidence = fullEvidence({
      identity: row.identity,
      role: 'builder',
      sessionMode: 'retained',
      outcome: 'UNSUPPORTED'
    })
    const verdict = resolveRouteCertification(evidence, {
      identity: row.identity,
      role: 'builder',
      sessionMode: 'retained',
      nowMs: NOW,
      currentCommitSha: SHA,
      currentRuntimeVersion: VERSION
    })
    expect(verdict.state).toBe('UNSUPPORTED')
    expect(verdict.blockingKinds.length).toBeGreaterThan(0)
  })

  it('covers every declared evidence kind across the two session modes', () => {
    const covered = new Set([
      ...requiredEvidenceKinds('fresh'),
      ...requiredEvidenceKinds('retained')
    ])
    for (const kind of ROUTE_EVIDENCE_KINDS) {
      expect(covered.has(kind)).toBe(true)
    }
  })
})

describe('B1 hard exclusions', () => {
  it('rejects local Qwen from Orca worker routing regardless of evidence', () => {
    const row = route({ identity: identity({ agent: 'qwen-code', model: 'qwen3.5' }) })
    expect(isExcludedWorkerAgent('qwen-code')).toBe(true)
    expect(
      admitRoute({
        ...baseAdmission,
        registry: [row],
        evidence: fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' }),
        requested: row.identity,
        effective: row.identity,
        requirement: { role: 'builder', sessionMode: 'fresh' }
      })
    ).toMatchObject({ ok: false, error: { code: 'agent_excluded' } })
  })

  it('rejects a Fable builder route that has not been certified for the builder role', () => {
    const row = route({ identity: identity({ model: 'fable' }), roles: ['reviewer'] })
    expect(
      admitRoute({
        ...baseAdmission,
        registry: [row],
        evidence: fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' }),
        requested: row.identity,
        effective: row.identity,
        requirement: { role: 'builder', sessionMode: 'fresh' }
      })
    ).toMatchObject({ ok: false, error: { code: 'role_not_eligible' } })
  })

  it('still admits Fable as a reviewer', () => {
    const row = route({ identity: identity({ model: 'fable' }), roles: ['reviewer'] })
    expect(
      admitRoute({
        ...baseAdmission,
        registry: [row],
        evidence: fullEvidence({ identity: row.identity, role: 'reviewer', sessionMode: 'fresh' }),
        requested: row.identity,
        effective: row.identity,
        requirement: { role: 'reviewer', sessionMode: 'fresh' }
      }).ok
    ).toBe(true)
  })
})

describe('B1 identity and readiness fail closed', () => {
  it('rejects a requested/effective identity mismatch', () => {
    const row = route()
    expect(
      admitRoute({
        ...baseAdmission,
        registry: [row],
        evidence: fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' }),
        requested: row.identity,
        effective: identity({ model: 'sonnet' }),
        requirement: { role: 'builder', sessionMode: 'fresh' }
      })
    ).toMatchObject({ ok: false, error: { code: 'identity_mismatch' } })
  })

  it('rejects a route with no effective identity at all', () => {
    const row = route()
    expect(
      admitRoute({
        ...baseAdmission,
        registry: [row],
        evidence: fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' }),
        requested: row.identity,
        effective: null,
        requirement: { role: 'builder', sessionMode: 'fresh' }
      })
    ).toMatchObject({ ok: false, error: { code: 'identity_mismatch' } })
  })

  it('rejects an alias-only identity proof as insufficient for certification', () => {
    const row = route({ identity: identity({ model: 'opus' }), identityProof: 'alias' })
    expect(checkRouteEligibility(row, { role: 'builder', sessionMode: 'fresh' })).toMatchObject({
      code: 'identity_proof_insufficient'
    })
  })

  it('rejects an unsupported reasoning mode', () => {
    const row = route({ reasoningModes: ['high'] })
    expect(
      checkRouteEligibility(row, { role: 'builder', sessionMode: 'fresh', reasoning: 'max' })
    ).toMatchObject({ code: 'reasoning_unsupported' })
  })

  it('rejects retained re-engagement on a route that only supports fresh sessions', () => {
    const row = route({ sessionModes: ['fresh'] })
    expect(checkRouteEligibility(row, { role: 'builder', sessionMode: 'retained' })).toMatchObject({
      code: 'session_mode_unsupported'
    })
  })

  it('refuses a launcher-supported but hook-rejected route', () => {
    const row = route({ hookSupported: false })
    expect(checkRouteEligibility(row, { role: 'builder', sessionMode: 'fresh' })).toMatchObject({
      code: 'launcher_hook_drift'
    })
  })

  it('never fabricates quota: UNKNOWN is unschedulable without an explicit opt-in', () => {
    const row = route({ readiness: unknownReadiness() })
    expect(checkRouteEligibility(row, { role: 'builder', sessionMode: 'fresh' })).toMatchObject({
      code: 'quota_unknown'
    })
    expect(
      checkRouteEligibility(row, { role: 'builder', sessionMode: 'fresh', allowUnknownQuota: true })
    ).toBeNull()
  })

  it('rejects an unavailable provider and an exhausted quota separately', () => {
    const unavailable = route({
      readiness: { ...route().readiness, availability: 'unavailable' }
    })
    const exhausted = route({
      readiness: {
        ...route().readiness,
        quota: { state: 'exhausted', resetAt: UNKNOWN, remainingFraction: UNKNOWN }
      }
    })
    expect(
      checkRouteEligibility(unavailable, { role: 'builder', sessionMode: 'fresh' })
    ).toMatchObject({ code: 'provider_unavailable' })
    expect(
      checkRouteEligibility(exhausted, { role: 'builder', sessionMode: 'fresh' })
    ).toMatchObject({
      code: 'quota_exhausted'
    })
  })

  it('rejects a task capability the route does not declare', () => {
    const row = route({ taskCapabilities: ['fast_fix'] })
    expect(
      checkRouteEligibility(row, {
        role: 'builder',
        sessionMode: 'fresh',
        taskCapabilities: ['large_multi_file_build']
      })
    ).toMatchObject({ code: 'capability_not_eligible' })
  })
})

describe('CORRECTION 1 model-agnostic selection', () => {
  const rows = [
    route({
      identity: identity({ agent: 'grok', model: 'grok-4.6', reasoning: null }),
      reasoningModes: []
    }),
    route({ identity: identity({ agent: 'claude', model: 'opus-5' }) }),
    route({ identity: identity({ agent: 'codex', model: 'gpt-5.6-sol' }) })
  ]
  const evidence = rows.flatMap((row) =>
    fullEvidence({ identity: row.identity, role: 'builder', sessionMode: 'fresh' })
  )

  it('eligibility is order-independent: permuting the registry yields the same set', () => {
    const forwards = listAdmissibleRoutes({
      ...baseAdmission,
      registry: rows,
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    }).map((entry) => routeKey(entry.identity))
    const backwards = listAdmissibleRoutes({
      ...baseAdmission,
      registry: rows.toReversed(),
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    }).map((entry) => routeKey(entry.identity))
    const shuffled = listAdmissibleRoutes({
      ...baseAdmission,
      registry: [rows[2], rows[0], rows[1]],
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' }
    }).map((entry) => routeKey(entry.identity))
    expect(forwards).toEqual(backwards)
    expect(forwards).toEqual(shuffled)
    expect(forwards).toHaveLength(3)
  })

  it('refuses to choose a provider when the caller supplies no candidate order', () => {
    expect(
      selectRoute({
        ...baseAdmission,
        registry: rows,
        evidence,
        requirement: { role: 'builder', sessionMode: 'fresh' },
        candidates: []
      })
    ).toMatchObject({ ok: false, code: 'no_candidate_order' })
  })

  it('follows the caller candidate order exactly, with no provider loyalty', () => {
    const grokFirst = selectRoute({
      ...baseAdmission,
      registry: rows,
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' },
      candidates: [rows[0].identity, rows[1].identity]
    })
    const claudeFirst = selectRoute({
      ...baseAdmission,
      registry: rows,
      evidence,
      requirement: { role: 'builder', sessionMode: 'fresh' },
      candidates: [rows[1].identity, rows[0].identity]
    })
    expect(grokFirst).toMatchObject({ ok: true })
    expect(claudeFirst).toMatchObject({ ok: true })
    expect(grokFirst.ok && routeKey(grokFirst.route.identity)).toBe(routeKey(rows[0].identity))
    expect(claudeFirst.ok && routeKey(claudeFirst.route.identity)).toBe(routeKey(rows[1].identity))
  })

  it('falls through to the next caller candidate only when the earlier one is not certified', () => {
    const partial = evidence.filter((record) => record.routeKey !== routeKey(rows[0].identity))
    const selection = selectRoute({
      ...baseAdmission,
      registry: rows,
      evidence: partial,
      requirement: { role: 'builder', sessionMode: 'fresh' },
      candidates: [rows[0].identity, rows[1].identity]
    })
    expect(selection.ok && routeKey(selection.route.identity)).toBe(routeKey(rows[1].identity))
  })

  it('returns every rejection reason rather than silently substituting a route', () => {
    const selection = selectRoute({
      ...baseAdmission,
      registry: rows,
      evidence: [],
      requirement: { role: 'builder', sessionMode: 'fresh' },
      candidates: [rows[0].identity, rows[1].identity, rows[2].identity]
    })
    expect(selection).toMatchObject({ ok: false, code: 'no_admissible_candidate' })
    expect(selection.ok === false && selection.rejected).toHaveLength(3)
    expect(
      selection.ok === false && selection.rejected.every((entry) => entry.code === 'route_untested')
    ).toBe(true)
  })
})

describe('CORRECTION 1 failure classification', () => {
  it('marks only a control-plane fault as safe for Orca to repair in place', () => {
    expect(
      classifyRouteFailure({ routeKey: 'r', class: 'control_plane', reason: 'lease wedged' })
    ).toMatchObject({ safeToRepairInPlace: true })
    for (const failureClass of [
      'provider_unavailable',
      'quota',
      'model_execution',
      'task_failure'
    ] as const) {
      expect(
        classifyRouteFailure({ routeKey: 'r', class: failureClass, reason: 'x' })
      ).toMatchObject({ class: failureClass, safeToRepairInPlace: false })
    }
  })
})

/** The bootstrap opens exactly one certification state: never-proven. A route
 *  that already FAILED, or whose evidence went STALE, has been proven and the
 *  answer was no; reopening either would turn the bootstrap into a way to
 *  relitigate a verdict rather than a way to obtain one. */
describe('BOOTSTRAP OPENS ONLY THE UNTESTED CASE', () => {
  const row = route()

  function admit(evidence: RouteEvidence[], bootstrapUncertified: boolean) {
    return admitRoute({
      ...baseAdmission,
      registry: [row],
      evidence,
      requested: row.identity,
      effective: row.identity,
      requirement: { role: 'builder', sessionMode: 'fresh' },
      bootstrapUncertified
    })
  }

  it('admits a never-proven route when a verified intent authorises it', () => {
    expect(admit([], true)).toMatchObject({ ok: true, bootstrap: true })
  })

  it('negative control: the same route is refused without one', () => {
    expect(admit([], false)).toMatchObject({ ok: false })
  })

  it('refuses a route whose evidence already FAILED, intent or not', () => {
    const failed = fullEvidence({
      identity: row.identity,
      role: 'builder',
      sessionMode: 'fresh',
      outcome: 'FAIL'
    })
    expect(admit(failed, true)).toMatchObject({ ok: false })
    expect(admit(failed, false)).toMatchObject({ ok: false })
  })

  it('refuses a route whose evidence went STALE, intent or not', () => {
    const stale = fullEvidence({
      identity: row.identity,
      role: 'builder',
      sessionMode: 'fresh',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    })
    expect(admit(stale, true)).toMatchObject({ ok: false })
  })
})
