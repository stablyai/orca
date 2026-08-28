import { afterEach, describe, expect, it } from 'vitest'
import { admitCertificationEvidence } from './certification-admission'
import type { CertificationObservationSource } from './certification-event-source'
import { OrchestrationDb } from '../db'
import type { RouteIdentity } from './route-registry-types'

/** CERTIFICATION_EVENT_INTEGRITY — a caller may REQUEST that a kind be
 *  certified; it may not DECLARE that the kind succeeded.
 *
 *  Before this correction a single launched Dispatch was enough to mint PASS
 *  for all ten evidence kinds, including `completion_receipt` on a Dispatch
 *  that never completed and `role_execution` for a role that never ran. The
 *  route then read fully certified on nothing but a launch.
 */
describe('CERTIFICATION_EVENT_INTEGRITY', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const SHA = 'a1b2c3d4e5f6'
  const STAMP = {
    observedAtIso: '2026-08-27T18:00:00Z',
    runtimeVersion: '1.0+deadbeef',
    commitSha: SHA
  }

  const BLIND: CertificationObservationSource = {
    observedEffectiveIdentity: () => null,
    agentStatusSnapshot: () => []
  }

  function launchedDispatch() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'codex',
        launch: {
          requested: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
          effective: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'pane:leaf',
      processIncarnation: 'pty:term_worker',
      launchTokenHash: 'hash',
      worktreeId: 'wt_1',
      effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }
    ])
    return started.dispatch.id
  }

  function certify(kind: string, dispatchId: string, source = BLIND) {
    return admitCertificationEvidence({
      db: db!,
      source,
      stamp: STAMP,
      request: {
        identity: IDENTITY,
        role: 'builder',
        sessionMode: 'fresh',
        kind,
        outcome: 'PASS',
        dispatchId,
        commitSha: SHA
      }
    })
  }

  it('refuses a completion receipt for a Dispatch that never completed', () => {
    const dispatchId = launchedDispatch()
    expect(certify('completion_receipt', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('refuses failure recovery with no recovery transition, and role execution that never ran', () => {
    const dispatchId = launchedDispatch()
    expect(certify('failure_recovery', dispatchId)).toMatchObject({ ok: false })
    expect(certify('role_execution', dispatchId)).toMatchObject({ ok: false })
  })

  it('refuses PreTool acceptance when the runtime observed no tool event', () => {
    const dispatchId = launchedDispatch()
    expect(certify('pretool_acceptance', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('fails closed on effective identity, and never accepts the request copied into the receipt', () => {
    const dispatchId = launchedDispatch()
    // The launch receipt's `effective` block IS the request, byte for byte.
    // Treating that as a provider receipt is the copying this pins.
    for (const kind of ['effective_model_identity', 'effective_reasoning_mode']) {
      expect(certify(kind, dispatchId), kind).toMatchObject({
        ok: false,
        code: 'evidence_not_observed'
      })
    }
  })

  it('accepts effective identity only from an independently observed receipt', () => {
    const dispatchId = launchedDispatch()
    const observing: CertificationObservationSource = {
      observedEffectiveIdentity: () => IDENTITY,
      agentStatusSnapshot: () => []
    }
    expect(certify('effective_model_identity', dispatchId, observing)).toMatchObject({ ok: true })
  })

  it('refuses a fresh_launch claim for a session mode the Dispatch did not run', () => {
    const dispatchId = launchedDispatch()
    expect(
      admitCertificationEvidence({
        db: db!,
        source: BLIND,
        stamp: STAMP,
        request: {
          identity: IDENTITY,
          role: 'builder',
          sessionMode: 'retained',
          kind: 'retained_re_engagement',
          outcome: 'PASS',
          dispatchId,
          commitSha: SHA
        }
      })
    ).toMatchObject({ ok: false, code: 'evidence_not_observed' })
  })

  it('still records FAIL and UNSUPPORTED cheaply, because they only restrict routing', () => {
    const dispatchId = launchedDispatch()
    for (const outcome of ['FAIL', 'UNSUPPORTED'] as const) {
      expect(
        admitCertificationEvidence({
          db: db!,
          source: BLIND,
          stamp: STAMP,
          request: {
            identity: IDENTITY,
            role: 'builder',
            sessionMode: 'fresh',
            kind: 'completion_receipt',
            outcome,
            dispatchId,
            commitSha: SHA
          }
        })
      ).toMatchObject({ ok: true })
    }
  })
})

/** The gaming paths a review found in the FIRST version of these rules. Each
 *  one minted PASS from a proxy that is not the event being certified. */
describe('CERTIFICATION_EVENT_INTEGRITY: closed gaming paths', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const SHA = 'a1b2c3d4e5f6'
  const STAMP = {
    observedAtIso: '2026-08-27T18:00:00Z',
    runtimeVersion: '1.0+deadbeef',
    commitSha: SHA
  }
  const BLIND: CertificationObservationSource = {
    observedEffectiveIdentity: () => null,
    agentStatusSnapshot: () => []
  }

  function settledDispatch(status: 'completed' | 'failed') {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'codex',
        launch: {
          requested: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
          effective: { agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'pane:leaf',
      processIncarnation: 'pty:term_worker',
      launchTokenHash: 'hash',
      worktreeId: 'wt_1',
      effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }
    ])
    db.db
      .prepare(
        `UPDATE dispatch_contexts SET status = ?, capability_revoked_at = datetime('now') WHERE id = ?`
      )
      .run(status, started.dispatch.id)
    return started.dispatch.id
  }

  function certify(kind: string, dispatchId: string, source = BLIND) {
    return admitCertificationEvidence({
      db: db!,
      source,
      stamp: STAMP,
      request: {
        identity: IDENTITY,
        role: 'builder',
        sessionMode: 'fresh',
        kind,
        outcome: 'PASS',
        dispatchId,
        commitSha: SHA
      }
    })
  }

  it('a revoked capability on a clean completion is NOT duplicate prevention', () => {
    // Every clean completion revokes its capability, so accepting that minted
    // PASS for a Dispatch nothing was ever replayed against.
    const dispatchId = settledDispatch('completed')
    expect(certify('duplicate_prevention', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('a failure with nothing after it is NOT a recovery', () => {
    const dispatchId = settledDispatch('failed')
    expect(certify('failure_recovery', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('a tool event is NOT an accepted PreTool decision', () => {
    const dispatchId = settledDispatch('completed')
    const withToolRow: CertificationObservationSource = {
      observedEffectiveIdentity: () => null,
      agentStatusSnapshot: () =>
        [
          {
            paneKey: 'pane:leaf',
            terminalHandle: 'term_worker',
            connectionId: null,
            receivedAt: Date.now(),
            stateStartedAt: Date.now(),
            state: 'working',
            toolName: 'Bash'
          }
        ] as never
    }
    expect(certify('pretool_acceptance', dispatchId, withToolRow)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('a launch token is NOT a safe-launch admission decision', () => {
    const dispatchId = settledDispatch('completed')
    expect(certify('safe_launch_acceptance', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })

  it('an effective identity that merely DIFFERS from the request is not provider-observed', () => {
    const dispatchId = settledDispatch('completed')
    // A catalog may legitimately transform a request without any provider
    // having reported anything, so difference alone is not provenance.
    expect(certify('effective_model_identity', dispatchId)).toMatchObject({
      ok: false,
      code: 'evidence_not_observed'
    })
  })
})
