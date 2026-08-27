import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkerStartRouteAdmitted } from '../../rpc/methods/orchestration-worker-route-admission'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'
import { OutcomePolicyStore } from './outcome-policy'
import { RouteRegistryStore } from './route-registry-store'
import { ROUTE_EVIDENCE_KINDS } from './route-certification-evidence'
import type { RouteIdentity } from './route-registry-types'

/** WORKER_START_IGNORES_OUTCOME_QUOTA_OPTIN — observed on candidate runtime
 *  `46755c49-b746-4184-bb1c-97ee670bd4f8`, Run `run_b69cf3f43d45`: the outcome
 *  was admitted with `--allow-unknown-quota` (persisted as
 *  `allow_unknown_quota = 1`), and `orchestration worker-start` still failed
 *  with `quota_unknown: ... requires an explicit policy opt-in`.
 *
 *  The automatic advance already read the policy; only the manual start path
 *  built its requirement without it, which made the documented opt-in unusable
 *  on the one path an operator drives by hand.
 */
describe('WORKER_START_IGNORES_OUTCOME_QUOTA_OPTIN', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const SHA = 'abc123'
  const NOW = Date.parse('2026-08-27T17:40:00Z')

  function world(allowUnknownQuota: boolean) {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    admitOutcome(new ControlPlaneStore(db), {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Outcome',
      fingerprint: 'f1'
    })
    new OutcomePolicyStore(db).put({
      outcomeId: 'out_1',
      taskClassification: 'bounded_implementation',
      builderCandidates: [IDENTITY],
      reviewerCandidates: [],
      reviewCapabilities: [],
      allowUnknownQuota
    })
    // A fully certified route whose only open question is its quota — exactly
    // the shape the opt-in exists for.
    const registry = new RouteRegistryStore(db)
    registry.upsertRoute({
      identity: IDENTITY,
      provider: 'UNKNOWN',
      harness: 'UNKNOWN',
      roles: ['builder'],
      taskCapabilities: ['bounded_implementation'],
      sessionModes: ['fresh'],
      reasoningModes: ['xhigh'],
      contextLimitTokens: 'UNKNOWN',
      costClass: 'UNKNOWN',
      identityProof: 'exact',
      launcherSupported: true,
      hookSupported: true,
      readiness: {
        availability: 'UNKNOWN',
        authenticated: 'UNKNOWN',
        providerStatus: 'UNKNOWN',
        quota: { state: 'UNKNOWN', resetAt: 'UNKNOWN', remainingFraction: 'UNKNOWN' }
      },
      constraints: [],
      notes: null
    })
    for (const kind of ROUTE_EVIDENCE_KINDS) {
      registry.recordRouteEvidence({
        routeKey: 'codex|gpt-5.5|xhigh',
        kind,
        role: 'builder',
        sessionMode: 'fresh',
        outcome: 'PASS',
        observedAt: new Date(NOW).toISOString(),
        runtimeVersion: 'cand',
        commitSha: SHA,
        detail: null
      })
    }
    return { runId: task.run_id }
  }

  function start(runId: string) {
    assertWorkerStartRouteAdmitted({
      handle: db!,
      runId,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
      role: 'builder',
      sessionMode: 'fresh',
      taskCapabilities: ['bounded_implementation'],
      nowMs: NOW
    })
  }

  it('starts a worker when the outcome explicitly opted into UNKNOWN quota', () => {
    const { runId } = world(true)
    expect(() => start(runId)).not.toThrow()
  })

  it('still refuses without the opt-in, so UNKNOWN quota is never assumed safe', () => {
    const { runId } = world(false)
    expect(() => start(runId)).toThrow(/quota_unknown/)
  })
})
