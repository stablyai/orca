import { afterEach, describe, expect, it } from 'vitest'
import {
  assertFederatedWorkerStartAdmitted,
  assertWorkerStartAdmitted
} from '../../rpc/methods/orchestration-worker-route-admission'
import { OrchestrationDb } from '../db'
import { certificationIntentId, mintCertificationIntent } from './certification-intent'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'
import { resolveRuntimeBuildIdentity } from './runtime-build-identity'
import { RouteRegistryStore } from './route-registry-store'
import { requiredEvidenceKinds } from './route-certification-evidence'
import { routeKey, UNKNOWN, type RouteIdentity, type RouteRow } from './route-registry-types'

/** CERTIFICATION_INTENT_AT_THE_ADMISSION_BOUNDARY
 *
 *  The intent's unit behaviour is covered elsewhere. This pins the seam where it
 *  meets a real worker-start: which launches it may open, which it must refuse,
 *  and — the bug this file was written for — that merely CARRYING an intent does
 *  not mark a Dispatch that never needed one.
 */
describe('CERTIFICATION_INTENT_AT_THE_ADMISSION_BOUNDARY', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'claude', model: 'opus[1m]', reasoning: 'high' }
  const WORKTREE = 'repo::/wt'

  function routeRow(): RouteRow {
    return {
      identity: IDENTITY,
      provider: 'anthropic',
      harness: 'claude-code',
      roles: ['builder', 'reviewer'],
      taskCapabilities: ['bounded_implementation'],
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

  function world(options: { certified: boolean }) {
    db = new OrchestrationDb(':memory:')
    const store = new ControlPlaneStore(db)
    const registry = new RouteRegistryStore(db)
    registry.upsertRoute(routeRow())
    const task = db.createTask({ spec: 'work' })
    admitOutcome(store, {
      outcomeId: 'out_1',
      runId: task.run_id,
      title: 'Ship',
      fingerprint: 'f'
    })
    if (options.certified) {
      const build = resolveRuntimeBuildIdentity()
      for (const kind of requiredEvidenceKinds('fresh')) {
        registry.recordRouteEvidence({
          routeKey: routeKey(IDENTITY),
          role: 'builder',
          sessionMode: 'fresh',
          kind,
          outcome: 'PASS',
          observedAt: new Date().toISOString(),
          commitSha: build.commitSha ?? '',
          runtimeVersion: build.id,
          detail: null
        })
      }
    }
    const intent = mintCertificationIntent(
      db,
      {
        runId: task.run_id,
        taskId: task.id,
        outcomeId: 'out_1',
        worktreeId: WORKTREE,
        identity: IDENTITY,
        buildId: resolveRuntimeBuildIdentity().id
      },
      new Date().toISOString()
    )
    return { task, runId: task.run_id, intentId: intent.intent_id }
  }

  function admit(args: { runId: string; taskId: string; intentId?: string }) {
    return assertWorkerStartAdmitted({
      handle: db!,
      runId: args.runId,
      taskId: args.taskId,
      agent: 'claude',
      model: 'opus[1m]',
      effort: 'high',
      worktreeId: WORKTREE,
      certificationIntent: args.intentId
    })
  }

  it('reports the bootstrap as USED when the route had no evidence at all', () => {
    const { runId, task, intentId } = world({ certified: false })
    expect(admit({ runId, taskId: task.id, intentId })).toEqual({ bootstrapUsed: true })
  })

  it('does NOT mark a Dispatch whose route was already certified', () => {
    // The bug this pins: carrying an intent that turned out to be unnecessary
    // used to consume it and brand the Dispatch a bootstrap, which can never
    // advance — silently discarding legitimate delivered work.
    const { runId, task, intentId } = world({ certified: true })
    expect(admit({ runId, taskId: task.id, intentId })).toEqual({ bootstrapUsed: false })
  })

  it('still refuses an uncertified route when no intent is offered', () => {
    const { runId, task } = world({ certified: false })
    expect(() => admit({ runId, taskId: task.id })).toThrow(/route_untested|not certified/i)
  })

  it('refuses an intent that names a different Task than the one starting', () => {
    const { runId, intentId } = world({ certified: false })
    const other = db!.createTask({ spec: 'other', runId })
    expect(() => admit({ runId, taskId: other.id, intentId })).toThrow(/not issued for Task/)
  })

  it('refuses an intent on a RETAINED re-engagement, which already launched', () => {
    const { runId, task, intentId } = world({ certified: false })
    expect(() =>
      assertWorkerStartAdmitted({
        handle: db!,
        runId,
        taskId: task.id,
        agent: 'claude',
        model: 'opus[1m]',
        effort: 'high',
        terminalHandle: 'term_existing',
        certificationIntent: intentId
      })
    ).toThrow(/retained re-engagement/)
  })

  it('refuses an intent on a FEDERATED start this runtime cannot witness', () => {
    const { runId, intentId } = world({ certified: false })
    expect(() =>
      assertFederatedWorkerStartAdmitted({
        handle: db!,
        runId,
        agent: 'claude',
        model: 'opus[1m]',
        effort: 'high',
        certificationIntent: intentId
      })
    ).toThrow(/local launch this runtime can observe/)
  })

  it('mints the same id for the same binding, so a replay is not a second grant', () => {
    const { runId, task } = world({ certified: false })
    expect(
      certificationIntentId({
        runId,
        taskId: task.id,
        outcomeId: 'out_1',
        worktreeId: WORKTREE,
        identity: IDENTITY,
        buildId: resolveRuntimeBuildIdentity().id
      })
    ).toMatch(/^ci_[0-9a-f]{32}$/)
  })
})
