import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkerStartRouteAdmitted } from '../../rpc/methods/orchestration-worker-route-admission'
import { admitCertificationEvidence } from './certification-admission'
import { resolveRouteCertification } from './route-certification-evidence'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'
import { OutcomePolicyStore } from './outcome-policy'
import { ROUTE_EVIDENCE_KINDS } from './route-certification-evidence'
import { RouteRegistryStore } from './route-registry-store'
import { resolveCandidateCommitSha } from './runtime-build-identity'
import type { RouteIdentity } from './route-registry-types'

/** SHA_RUNTIME_BINDING — worker-start admitted a route on certification
 *  evidence with no SHA or runtime binding at all, so evidence earned on one
 *  commit or one build silently admitted a worker on completely different code.
 */
describe('SHA_RUNTIME_BINDING', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const NOW = Date.parse('2026-08-27T18:00:00Z')
  const SHA_A = 'aaaaaaaaaaaa'
  const SHA_B = 'bbbbbbbbbbbb'
  const BUILD_A = '1.0+aaaa'
  const BUILD_B = '1.0+bbbb'

  function world(args: { sha: string; build: string }) {
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
      allowUnknownQuota: true
    })
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
        runtimeVersion: args.build,
        commitSha: args.sha,
        detail: null
      })
    }
    return { runId: task.run_id }
  }

  function start(runId: string, build: string) {
    assertWorkerStartRouteAdmitted({
      handle: db!,
      runId,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
      role: 'builder',
      sessionMode: 'fresh',
      taskCapabilities: ['bounded_implementation'],
      nowMs: NOW,
      runtimeBuildIdentity: { id: build }
    })
  }

  it('admits a worker when evidence matches the current SHA and build', () => {
    const { runId } = world({ sha: SHA_A, build: BUILD_A })
    expect(() => start(runId, BUILD_A)).not.toThrow()
  })

  it('rejects evidence earned on runtime A when runtime B is asking (build A -> build B)', () => {
    const { runId } = world({ sha: SHA_A, build: BUILD_A })
    expect(() => start(runId, BUILD_B)).toThrow(/route_not_certified|stale|UNTESTED|untested/i)
  })

  it('rejects evidence whose SHA contradicts itself for one build (SHA A -> SHA B)', () => {
    const { runId } = world({ sha: SHA_A, build: BUILD_A })
    // A second SHA appearing under the SAME build is a contradiction, so the
    // pinned candidate SHA can no longer match anything.
    new RouteRegistryStore(db!).recordRouteEvidence({
      routeKey: 'codex|gpt-5.5|xhigh',
      kind: 'fresh_launch',
      role: 'builder',
      sessionMode: 'fresh',
      outcome: 'PASS',
      observedAt: new Date(NOW + 1).toISOString(),
      runtimeVersion: BUILD_A,
      commitSha: SHA_B,
      detail: null
    })
    expect(() => start(runId, BUILD_A)).toThrow(/route_stale/)
  })

  it('pins one SHA per build and refuses to guess when they disagree', () => {
    const rows = [
      { runtimeVersion: BUILD_A, commitSha: SHA_A },
      { runtimeVersion: BUILD_B, commitSha: SHA_B }
    ].map((row) => ({
      routeKey: 'codex|gpt-5.5|xhigh',
      kind: 'fresh_launch' as const,
      role: 'builder' as const,
      sessionMode: 'fresh' as const,
      outcome: 'PASS' as const,
      observedAt: new Date(NOW).toISOString(),
      detail: null,
      ...row
    }))
    expect(resolveCandidateCommitSha(rows, BUILD_A)).toBe(SHA_A)
    expect(resolveCandidateCommitSha(rows, BUILD_B)).toBe(SHA_B)
    expect(resolveCandidateCommitSha(rows, 'unknown-build')).toBeNull()
    expect(resolveCandidateCommitSha([...rows, { ...rows[0], commitSha: SHA_B }], BUILD_A)).toBe(
      'contradicted'
    )
  })
})

/** The half the live candidate proved was missing: a caller could hand
 *  `orchestration certify` ANY hexadecimal SHA and the runtime wrote it. Wrong
 *  evidence must be refused at RECORD time, not discovered later as staleness.
 */
describe('SHA_RUNTIME_BINDING at record time', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const IDENTITY: RouteIdentity = { agent: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' }
  const NOW = Date.parse('2026-08-27T18:00:00Z')
  const RUNTIME_SHA = 'a'.repeat(40)
  const OTHER_SHA = 'b'.repeat(40)
  const BUILD_A = `1.0+aaaa+${RUNTIME_SHA}`
  const BUILD_B = `1.0+bbbb+${OTHER_SHA}`

  function launched() {
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
    return started.dispatch.id
  }

  function certify(claimedSha: string, runtimeCommit: string | null, buildId = BUILD_A) {
    // Why first: the object literal below reads `db` before `launched()` would
    // have created it.
    const dispatchId = launched()
    return admitCertificationEvidence({
      db: db!,
      source: { observedEffectiveIdentity: () => null, agentStatusSnapshot: () => [] },
      stamp: {
        observedAtIso: '2026-08-27T18:00:00Z',
        runtimeVersion: buildId,
        commitSha: runtimeCommit
      },
      request: {
        identity: IDENTITY,
        role: 'builder',
        sessionMode: 'fresh',
        kind: 'fresh_launch',
        outcome: 'PASS',
        dispatchId,
        commitSha: claimedSha
      }
    })
  }

  it('records PASS when the claimed commit is the one the runtime was built from', () => {
    expect(certify(RUNTIME_SHA, RUNTIME_SHA)).toMatchObject({ ok: true })
  })

  it('refuses SHA A evidence on a runtime built from SHA B (SHA A -> SHA B)', () => {
    expect(certify(OTHER_SHA, RUNTIME_SHA)).toMatchObject({ ok: false, code: 'sha_mismatch' })
  })

  it('stamps the RUNTIME commit, so a caller cannot substitute its own', () => {
    const admitted = certify(RUNTIME_SHA, RUNTIME_SHA)
    expect(admitted.ok && admitted.evidence.commitSha).toBe(RUNTIME_SHA)
  })

  it('refuses SHA-bound evidence when the runtime cannot establish its own commit', () => {
    expect(certify(RUNTIME_SHA, null)).toMatchObject({ ok: false, code: 'commit_unknown' })
  })

  it('carries the commit in the build identity, so runtime A and runtime B differ (runtime A -> runtime B)', () => {
    expect(BUILD_A).not.toBe(BUILD_B)
    const onA = certify(RUNTIME_SHA, RUNTIME_SHA, BUILD_A)
    expect(onA.ok && onA.evidence.runtimeVersion).toBe(BUILD_A)
    // The same evidence read on runtime B is stale: its runtimeVersion differs.
    expect(
      resolveRouteCertification(onA.ok ? [onA.evidence] : [], {
        identity: IDENTITY,
        role: 'builder',
        sessionMode: 'fresh',
        nowMs: NOW,
        currentCommitSha: RUNTIME_SHA,
        currentRuntimeVersion: BUILD_B
      }).state
    ).not.toBe('PASS')
  })
})
