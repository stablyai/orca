import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import {
  bindCertificationIntentToDispatch,
  certificationIntentId,
  getCertificationIntent,
  claimCertificationIntent,
  mintCertificationIntent,
  releaseCertificationIntentClaim,
  verifyCertificationIntent,
  wasCertificationBootstrapDispatch,
  type CertificationIntentBinding
} from './certification-intent'
import { ControlPlaneStore } from './control-plane-store'
import { admitOutcome } from './outcome-identity'

/** CERTIFICATION_BOOTSTRAP_MUST_NOT_BE_A_CALLER_CLAIM
 *
 *  Certification evidence can only be produced by a real launch, so SOMETHING
 *  has to permit the first launch of a never-proven route. The first attempt at
 *  that was a boolean on worker-start, which is precisely the defect this whole
 *  package exists to remove: a caller-declared claim trusted as authority.
 *
 *  The opening is now a typed intent the runtime mints and then matches, field
 *  by field, against the launch it is actually about to perform.
 */
describe('CERTIFICATION_BOOTSTRAP_MUST_NOT_BE_A_CALLER_CLAIM', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const BINDING: CertificationIntentBinding = {
    runId: 'run_1',
    taskId: 'task_1',
    outcomeId: 'out_1',
    worktreeId: 'repo::/wt',
    identity: { agent: 'claude', model: 'fable', reasoning: 'high' },
    buildId: 'build-1'
  }

  // The tables are created by opening the control plane; the intent functions
  // then work directly against the same handle.
  function store(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    const cp = new ControlPlaneStore(db)
    admitOutcome(cp, { outcomeId: 'out_1', runId: 'run_1', title: 'A', fingerprint: 'f' })
    return db
  }

  function mint(cp: OrchestrationDb) {
    return mintCertificationIntent(cp, BINDING, '2026-01-01T00:00:00.000Z')
  }

  it('accepts an intent that names exactly the launch being performed', () => {
    const cp = store()
    const intent = mint(cp)
    expect(
      verifyCertificationIntent(cp, { intentId: intent.intent_id, actual: BINDING })
    ).toMatchObject({ ok: true })
  })

  it('refuses an intent id nobody minted', () => {
    expect(
      verifyCertificationIntent(store(), { intentId: 'ci_forged', actual: BINDING })
    ).toMatchObject({ ok: false, code: 'intent_unknown' })
  })

  it.each([
    ['runId', { runId: 'run_other' }, 'intent_run_mismatch'],
    ['taskId', { taskId: 'task_other' }, 'intent_task_mismatch'],
    ['outcomeId', { outcomeId: 'out_other' }, 'intent_outcome_mismatch'],
    ['worktreeId', { worktreeId: 'repo::/elsewhere' }, 'intent_worktree_mismatch'],
    ['buildId', { buildId: 'build-2' }, 'intent_build_mismatch']
  ])('refuses an intent whose %s is not the one being launched', (_label, override, code) => {
    const cp = store()
    const intent = mint(cp)
    expect(
      verifyCertificationIntent(cp, {
        intentId: intent.intent_id,
        actual: { ...BINDING, ...(override as Partial<CertificationIntentBinding>) }
      })
    ).toMatchObject({ ok: false, code })
  })

  it('refuses an intent issued for a different route', () => {
    const cp = store()
    const intent = mint(cp)
    expect(
      verifyCertificationIntent(cp, {
        intentId: intent.intent_id,
        actual: { ...BINDING, identity: { agent: 'claude', model: 'opus', reasoning: 'high' } }
      })
    ).toMatchObject({ ok: false, code: 'intent_route_mismatch' })
  })

  it('is single-use: two concurrent launches yield exactly one winner', () => {
    const cp = store()
    const intent = mint(cp)
    const claims = ['claim:a', 'claim:b'].map((claimId) =>
      claimCertificationIntent(cp, { intentId: intent.intent_id, claimId, nowIso: 'now' })
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(
      verifyCertificationIntent(cp, { intentId: intent.intent_id, actual: BINDING })
    ).toMatchObject({ ok: false, code: 'intent_consumed' })
  })

  it('claims BEFORE a Dispatch exists, so a losing race leaves no orphan', () => {
    const cp = store()
    const intent = mint(cp)
    // The winner claims, then binds the Dispatch it actually created.
    expect(
      claimCertificationIntent(cp, {
        intentId: intent.intent_id,
        claimId: 'claim:a',
        nowIso: 'now'
      })
    ).toBe(true)
    // The loser is refused while the database still holds nothing for it, so it
    // never reaches createStartingWorkerDispatch at all.
    expect(
      claimCertificationIntent(cp, {
        intentId: intent.intent_id,
        claimId: 'claim:b',
        nowIso: 'now'
      })
    ).toBe(false)
    bindCertificationIntentToDispatch(cp, { intentId: intent.intent_id, dispatchId: 'ctx_real' })
    expect(getCertificationIntent(cp, intent.intent_id)?.consumed_dispatch_id).toBe('ctx_real')
    expect(wasCertificationBootstrapDispatch(cp, 'ctx_real')).toBe(true)
  })

  it('returns the claim when the Dispatch was never created, so nothing is burned', () => {
    const cp = store()
    const intent = mint(cp)
    claimCertificationIntent(cp, { intentId: intent.intent_id, claimId: 'claim:a', nowIso: 'now' })
    releaseCertificationIntentClaim(cp, { intentId: intent.intent_id, claimId: 'claim:a' })
    expect(
      verifyCertificationIntent(cp, { intentId: intent.intent_id, actual: BINDING })
    ).toMatchObject({ ok: true })
    // A release must be exact: another claim's id cannot free someone else's.
    claimCertificationIntent(cp, { intentId: intent.intent_id, claimId: 'claim:a', nowIso: 'now' })
    releaseCertificationIntentClaim(cp, { intentId: intent.intent_id, claimId: 'claim:other' })
    expect(
      verifyCertificationIntent(cp, { intentId: intent.intent_id, actual: BINDING })
    ).toMatchObject({ ok: false, code: 'intent_consumed' })
  })

  it('gives a RETRY its own grant, so a failed launch can be picked up again', () => {
    const cp = store()
    const first = mint(cp)
    claimCertificationIntent(cp, { intentId: first.intent_id, claimId: 'c1', nowIso: 'n' })
    // The first attempt died; without a distinct binding the retry would
    // re-derive the consumed id and the Task could never be picked up again.
    const retry = mintCertificationIntent(
      cp,
      { ...BINDING, retryOfDispatchId: 'ctx_failed' },
      '2026-01-01T00:00:00.000Z'
    )
    expect(retry.intent_id).not.toBe(first.intent_id)
    expect(
      verifyCertificationIntent(cp, {
        intentId: retry.intent_id,
        actual: { ...BINDING, retryOfDispatchId: 'ctx_failed' }
      })
    ).toMatchObject({ ok: true })
  })

  it('a retry grant still names the attempt it is for', () => {
    const cp = store()
    const retry = mintCertificationIntent(
      cp,
      { ...BINDING, retryOfDispatchId: 'ctx_failed' },
      '2026-01-01T00:00:00.000Z'
    )
    // Presented as a first attempt, it is not the same authorisation.
    expect(
      verifyCertificationIntent(cp, { intentId: retry.intent_id, actual: BINDING })
    ).toMatchObject({ ok: false })
  })

  it('mints deterministically, so a replay is the same authorisation not a second one', () => {
    const cp = store()
    expect(mint(cp).intent_id).toBe(certificationIntentId(BINDING))
    expect(mint(cp).intent_id).toBe(certificationIntentId(BINDING))
    claimCertificationIntent(cp, {
      intentId: certificationIntentId(BINDING),
      claimId: 'c',
      nowIso: 'n'
    })
    // Re-minting must not resurrect a consumed authorisation.
    expect(mint(cp).consumed_at).not.toBeNull()
  })

  it('marks only the bootstrap Dispatch, so ordinary work is unaffected', () => {
    const cp = store()
    const intent = mint(cp)
    claimCertificationIntent(cp, { intentId: intent.intent_id, claimId: 'c', nowIso: 'n' })
    bindCertificationIntentToDispatch(cp, { intentId: intent.intent_id, dispatchId: 'ctx_boot' })
    expect(wasCertificationBootstrapDispatch(cp, 'ctx_boot')).toBe(true)
    expect(wasCertificationBootstrapDispatch(cp, 'ctx_ordinary')).toBe(false)
  })
})
