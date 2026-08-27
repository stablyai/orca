import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import {
  admitCertificationEvidence,
  buildCertificationMatrix,
  type CertificationRequest
} from './certification-admission'
import { RouteRegistryStore } from './route-registry-store'
import { UNKNOWN, type RouteIdentity, type RouteRow } from './route-registry-types'

const SHA = 'a1b2c3d4e5f6'
const IDENTITY: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }
const STAMP = { observedAtIso: '2026-08-27T12:00:00.000Z', runtimeVersion: '1.4.188' }

function request(overrides: Partial<CertificationRequest> = {}): CertificationRequest {
  return {
    identity: IDENTITY,
    role: 'builder',
    sessionMode: 'fresh',
    kind: 'fresh_launch',
    outcome: 'PASS',
    commitSha: SHA,
    ...overrides
  }
}

describe('correction 2: live certification cannot be fabricated', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function open(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('refuses PASS with no Dispatch at all', () => {
    expect(
      admitCertificationEvidence({ db: open(), request: request(), stamp: STAMP })
    ).toMatchObject({
      ok: false,
      code: 'unknown_dispatch'
    })
  })

  it('refuses PASS for a Dispatch that does not exist', () => {
    expect(
      admitCertificationEvidence({
        db: open(),
        request: request({ dispatchId: 'ctx_nope' }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'unknown_dispatch' })
  })

  it('negative control: a synthetic Dispatch with no real launch cannot mint PASS', () => {
    const database = open()
    const task = database.createTask({ spec: 'work' })
    // A hand-made Dispatch has no process incarnation, because only the
    // terminal-authority path after a real agent pane became ready writes one.
    const dispatch = createRootDispatch(database, task.id, 'term_worker')
    expect(
      admitCertificationEvidence({
        db: database,
        request: request({ dispatchId: dispatch.id }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'dispatch_not_launched' })
  })

  it('refuses PASS when the Dispatch has an incarnation but no persisted launch receipt', () => {
    const database = open()
    const task = database.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(
      database,
      task.id,
      'term_worker',
      'tab:leaf',
      undefined,
      'pty:1'
    )
    expect(
      admitCertificationEvidence({
        db: database,
        request: request({ dispatchId: dispatch.id }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'launch_route_unknown' })
  })

  it('refuses PASS when the real launch ran a different route', () => {
    const database = open()
    const dispatch = launchedDispatch(database, {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high'
    })
    expect(
      admitCertificationEvidence({
        db: database,
        request: request({ dispatchId: dispatch }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'identity_mismatch' })
  })

  it('accepts PASS for a real launch whose recorded route matches exactly', () => {
    const database = open()
    const dispatch = launchedDispatch(database, IDENTITY)
    const admission = admitCertificationEvidence({
      db: database,
      request: request({ dispatchId: dispatch }),
      stamp: STAMP
    })
    expect(admission.ok).toBe(true)
    // The runtime's stamp wins: a caller cannot backdate or restate it.
    expect(admission.ok && admission.evidence).toMatchObject({
      observedAt: STAMP.observedAtIso,
      runtimeVersion: STAMP.runtimeVersion,
      commitSha: SHA
    })
  })

  it('accepts FAIL and UNSUPPORTED without any launch, because they only restrict', () => {
    const database = open()
    for (const outcome of ['FAIL', 'UNSUPPORTED'] as const) {
      expect(
        admitCertificationEvidence({ db: database, request: request({ outcome }), stamp: STAMP }).ok
      ).toBe(true)
    }
  })

  it('rejects an unknown evidence kind and a non-hex SHA', () => {
    const database = open()
    expect(
      admitCertificationEvidence({
        db: database,
        request: request({ outcome: 'FAIL', kind: 'vibes' }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'invalid_kind' })
    expect(
      admitCertificationEvidence({
        db: database,
        request: request({ outcome: 'FAIL', commitSha: 'not-a-sha' }),
        stamp: STAMP
      })
    ).toMatchObject({ ok: false, code: 'invalid_sha' })
  })
})

function launchedDispatch(db: OrchestrationDb, identity: RouteIdentity): string {
  const task = db.createTask({ spec: 'work' })
  const started = db.createStartingWorkerDispatch({
    taskId: task.id,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    startOptions: {
      agent: identity.agent,
      launch: {
        requested: { agent: identity.agent, model: identity.model, effort: identity.reasoning },
        effective: { agent: identity.agent, model: identity.model, effort: identity.reasoning }
      }
    }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_worker',
    paneKey: 'term_worker:leaf',
    processIncarnation: 'pty:real',
    launchTokenHash: 'hash',
    worktreeId: 'wt_1',
    // A real fresh launch records that it CREATED the agent pane; that record
    // is what the runtime reads back to certify `fresh_launch`.
    effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id, [
    { kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }
  ])
  return started.dispatch.id
}

describe('correction 2: the role/session certification matrix', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('reports every role and session mode with the outstanding evidence kinds named', () => {
    db = new OrchestrationDb(':memory:')
    const store = new RouteRegistryStore(db)
    const row: RouteRow = {
      identity: IDENTITY,
      provider: 'anthropic',
      harness: 'claude-code',
      roles: ['builder'],
      taskCapabilities: [],
      sessionModes: ['fresh'],
      reasoningModes: ['high'],
      contextLimitTokens: UNKNOWN,
      costClass: UNKNOWN,
      identityProof: 'exact',
      launcherSupported: true,
      hookSupported: true,
      readiness: {
        availability: UNKNOWN,
        authenticated: UNKNOWN,
        providerStatus: UNKNOWN,
        quota: { state: UNKNOWN, resetAt: UNKNOWN, remainingFraction: UNKNOWN }
      },
      constraints: [],
      notes: null
    }
    store.upsertRoute(row)
    const matrix = buildCertificationMatrix({ db, nowMs: Date.parse('2026-08-27T12:00:00.000Z') })
    expect(matrix).toHaveLength(1)
    expect(matrix[0].cells.map((cell) => `${cell.role}/${cell.sessionMode}=${cell.state}`)).toEqual(
      [
        'builder/fresh=UNTESTED',
        'builder/retained=UNTESTED',
        'reviewer/fresh=UNTESTED',
        'reviewer/retained=UNTESTED'
      ]
    )
    expect(matrix[0].missing['builder:fresh']).toContain('fresh_launch')
    expect(matrix[0].missing['reviewer:retained']).toContain('retained_re_engagement')
  })
})
