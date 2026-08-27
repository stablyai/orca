import { describe, expect, it } from 'vitest'
import {
  planNextAfterBuild,
  type BuilderCompletion,
  type RetainedBuilder
} from './reviewer-advance'
import { requiredEvidenceKinds, type RouteEvidence } from './route-certification-evidence'
import {
  routeKey,
  UNKNOWN,
  type RouteIdentity,
  type RouteRole,
  type RouteRow,
  type SessionMode
} from './route-registry-types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const SHA = 'abc1234'
const VERSION = '1.4.188'
const FINAL_SHA = 'deadbeef1234'

const builderIdentity: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }
const reviewerIdentity: RouteIdentity = { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }

function row(identity: RouteIdentity, roles: RouteRole[]): RouteRow {
  return {
    identity,
    provider: 'p',
    harness: 'h',
    roles,
    taskCapabilities: ['bounded_implementation', 'adversarial_review'],
    sessionModes: ['fresh', 'retained'],
    reasoningModes: ['high'],
    contextLimitTokens: UNKNOWN,
    costClass: UNKNOWN,
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
    notes: null
  }
}

function evidenceFor(
  identity: RouteIdentity,
  role: RouteRole,
  sessionMode: SessionMode
): RouteEvidence[] {
  return requiredEvidenceKinds(sessionMode).map((kind) => ({
    routeKey: routeKey(identity),
    kind,
    role,
    sessionMode,
    outcome: 'PASS' as const,
    observedAt: '2026-08-27T11:00:00.000Z',
    runtimeVersion: VERSION,
    commitSha: SHA,
    detail: null
  }))
}

const registry = [row(builderIdentity, ['builder']), row(reviewerIdentity, ['reviewer'])]
const evidence = [
  ...evidenceFor(builderIdentity, 'builder', 'retained'),
  ...evidenceFor(reviewerIdentity, 'reviewer', 'fresh')
]

function completion(overrides: Partial<BuilderCompletion> = {}): BuilderCompletion {
  return {
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    runId: 'run_1',
    outcomeId: 'out_1',
    finalSha: FINAL_SHA,
    validated: true,
    ...overrides
  }
}

const retainedBuilder: RetainedBuilder = {
  dispatchId: 'ctx_1',
  terminalHandle: 'term_builder',
  identity: builderIdentity,
  sessionRetained: true
}

const base = {
  registry,
  evidence,
  nowMs: NOW,
  currentCommitSha: SHA,
  currentRuntimeVersion: VERSION
}

describe('B7 builder to reviewer advance', () => {
  it('refuses to start review before the completion is validated', () => {
    expect(
      planNextAfterBuild({
        ...base,
        completion: completion({ validated: false }),
        reviewerCandidates: [reviewerIdentity]
      })
    ).toMatchObject({ kind: 'blocked', code: 'completion_not_validated' })
  })

  it('advances a validated completion to an independently configured reviewer bound to the exact SHA', () => {
    const plan = planNextAfterBuild({
      ...base,
      completion: completion(),
      reviewerCandidates: [reviewerIdentity],
      retainedBuilder
    })
    expect(plan).toMatchObject({ kind: 'review', role: 'reviewer', boundSha: FINAL_SHA })
    expect(plan.kind === 'review' && routeKey(plan.route.identity)).toBe(routeKey(reviewerIdentity))
  })

  it('never selects the route that authored the commit as its own reviewer', () => {
    const registryWithDualRole = [row(builderIdentity, ['builder', 'reviewer']), registry[1]]
    const evidenceWithDualRole = [...evidence, ...evidenceFor(builderIdentity, 'reviewer', 'fresh')]
    // Even when the authoring route IS certified as a reviewer and is offered
    // first, it must not be chosen to grade its own work.
    const plan = planNextAfterBuild({
      ...base,
      registry: registryWithDualRole,
      evidence: evidenceWithDualRole,
      completion: completion(),
      reviewerCandidates: [builderIdentity, reviewerIdentity],
      excludeRoute: builderIdentity,
      retainedBuilder
    })
    expect(plan.kind === 'review' && routeKey(plan.route.identity)).toBe(routeKey(reviewerIdentity))
  })

  it('negative control: without the exclusion the authoring route would be picked first', () => {
    const registryWithDualRole = [row(builderIdentity, ['builder', 'reviewer']), registry[1]]
    const evidenceWithDualRole = [...evidence, ...evidenceFor(builderIdentity, 'reviewer', 'fresh')]
    const plan = planNextAfterBuild({
      ...base,
      registry: registryWithDualRole,
      evidence: evidenceWithDualRole,
      completion: completion(),
      reviewerCandidates: [builderIdentity, reviewerIdentity]
    })
    expect(plan.kind === 'review' && routeKey(plan.route.identity)).toBe(routeKey(builderIdentity))
  })

  it('emits the protected blocker when no certified reviewer route exists', () => {
    expect(
      planNextAfterBuild({
        ...base,
        evidence: evidenceFor(builderIdentity, 'builder', 'retained'),
        completion: completion(),
        reviewerCandidates: [reviewerIdentity]
      })
    ).toMatchObject({ kind: 'blocked', code: 'no_certified_reviewer_route' })
  })

  it('negative control: with no reviewer candidate order it blocks instead of picking one', () => {
    expect(planNextAfterBuild({ ...base, completion: completion() })).toMatchObject({
      kind: 'blocked',
      code: 'no_certified_reviewer_route'
    })
  })

  it('produces exactly one next step, never a fan-out and never a merge or deploy', () => {
    const plan = planNextAfterBuild({
      ...base,
      completion: completion(),
      reviewerCandidates: [reviewerIdentity]
    })
    expect(Object.keys(plan)).not.toContain('routes')
    expect(JSON.stringify(plan)).not.toMatch(/merge|deploy|push/i)
  })
})

describe('B7 FIX_FIRST', () => {
  it('routes one consolidated correction back to the same retained builder', () => {
    const plan = planNextAfterBuild({
      ...base,
      completion: completion(),
      corrections: ['fix the null check', 'add the missing test'],
      retainedBuilder,
      reviewerCandidates: [reviewerIdentity]
    })
    expect(plan).toMatchObject({
      kind: 'fix_first',
      builderDispatchId: 'ctx_1',
      terminalHandle: 'term_builder',
      boundSha: FINAL_SHA
    })
    expect(plan.kind === 'fix_first' && plan.corrections).toHaveLength(2)
    expect(plan.kind === 'fix_first' && routeKey(plan.route.identity)).toBe(
      routeKey(builderIdentity)
    )
  })

  it('blocks FIX_FIRST when the builder session is no longer retained', () => {
    expect(
      planNextAfterBuild({
        ...base,
        completion: completion(),
        corrections: ['fix it'],
        retainedBuilder: { ...retainedBuilder, sessionRetained: false }
      })
    ).toMatchObject({ kind: 'blocked', code: 'builder_session_not_retained' })
  })

  it('blocks FIX_FIRST when the retained builder route is no longer certified', () => {
    expect(
      planNextAfterBuild({
        ...base,
        evidence: evidenceFor(reviewerIdentity, 'reviewer', 'fresh'),
        completion: completion(),
        corrections: ['fix it'],
        retainedBuilder
      })
    ).toMatchObject({ kind: 'blocked', code: 'builder_route_not_certified' })
  })
})
