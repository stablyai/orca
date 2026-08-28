import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { listPretoolReceipts } from './pretool-receipt'
import { acquireValidationLease, releaseValidationLease } from './validation-lease'
import { validationScopeKeyForWorktree } from './validation-scope'
import { resolveWorkerMutationVerdict, type AttestedSession } from './worker-mutation-verdict'

const NOW = Date.parse('2026-08-28T04:00:00.000Z')
const WORKTREE = 'repo_a::/Users/x/orca/workspaces/orca-jb/jb-workflow-control-plane-b'

describe('the fence reaches a worker that is already running', () => {
  let db: OrchestrationDb
  let owner: AttestedSession

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    owner = {
      terminalHandle: 'term_worker',
      paneKey: 'tab_1:leaf_1',
      processIncarnation: 'pty:term_worker',
      worktreeId: WORKTREE
    }
  })
  afterEach(() => db?.close())

  function takeLease(leaseOwner = 'gate_runner'): string {
    const acquired = acquireValidationLease(new ControlPlaneStore(db), {
      scopeKey: validationScopeKeyForWorktree(WORKTREE),
      leaseId: 'lease_1',
      owner: leaseOwner,
      idempotencyKey: 'idem_1',
      nowMs: NOW
    })
    expect(acquired.ok).toBe(true)
    return 'lease_1'
  }

  function verdict(session: AttestedSession = owner) {
    return resolveWorkerMutationVerdict({ db, session, nowMs: NOW })
  }

  it('NEGATIVE CONTROL: an already-running worker gets a typed deny and the file is untouched', () => {
    // Two certification workers edited and committed the Package B checkout while
    // a gate held a lease on it. Neither used an Orca-managed RPC — they used
    // their own Bash and Edit tools, so `terminal.send` fencing never saw them.
    const file = join(mkdtempSync(join(tmpdir(), 'orca-fence-')), 'role-route-registry.ts')
    const original = "if (route.identityProof !== 'exact') {\n"
    writeFileSync(file, original)
    const before = readFileSync(file)

    takeLease()
    const decision = verdict()

    // This is the decision point: the policy writes only on allow.
    if (decision.decision === 'allow') {
      writeFileSync(file, 'CONTAMINATED')
    }

    expect(decision).toMatchObject({
      decision: 'deny',
      code: 'validation_in_progress',
      worktreeId: WORKTREE
    })
    expect(decision.decision === 'deny' && decision.reason).toMatch(/would contaminate it/)
    expect(readFileSync(file)).toEqual(before)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('denies every tool call, not just the ones that route through Orca', () => {
    takeLease()
    // The verdict is a property of the workspace, so Bash, Edit and Write are
    // one answer rather than three allowlists that can disagree.
    for (const _tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(verdict().decision).toBe('deny')
    }
  })

  it('a wrong pane or process cannot borrow the owner’s answer', () => {
    takeLease()
    // The lease is on the workspace, so a different pane IN it is denied too...
    expect(verdict({ ...owner, paneKey: 'tab_9:leaf_9' }).decision).toBe('deny')
    // ...and a session the runtime never attested gets no answer at all rather
    // than the owner's.
    for (const blind of [
      { ...owner, paneKey: null },
      { ...owner, terminalHandle: undefined },
      { ...owner, worktreeId: null }
    ]) {
      expect(verdict(blind)).toMatchObject({ decision: 'deny', code: 'unattested' })
    }
  })

  it('a caller cannot exempt itself: there is no field to claim holder with', () => {
    takeLease()
    // The holder is derived from the lease's stored owner Dispatch, so a session
    // that does not resolve to that Dispatch has nothing it could say to become
    // exempt. The fenced worker has no active Dispatch here, so it is denied.
    expect(verdict().decision).toBe('deny')
    expect(
      Object.keys(resolveWorkerMutationVerdict({ db, session: owner, nowMs: NOW }))
    ).not.toContain('holderLeaseId')
  })

  it('asking the question mints nothing: no receipt, no proof', () => {
    takeLease()
    verdict()
    verdict()
    // A verdict is a read. If asking could write, a worker could ask its way to
    // a pretool_acceptance receipt without any policy ever deciding anything.
    expect(listPretoolReceipts(db, 'ctx_any')).toEqual([])
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM control_plane_pretool_receipts').get()).toEqual(
      { n: 0 }
    )
  })

  it('a rightful release lets the same worker mutate again', () => {
    const leaseId = takeLease()
    expect(verdict().decision).toBe('deny')
    expect(
      releaseValidationLease(new ControlPlaneStore(db), {
        scopeKey: validationScopeKeyForWorktree(WORKTREE),
        leaseId,
        owner: 'gate_runner',
        nowMs: NOW + 1000
      })
    ).toEqual({ released: true })
    expect(verdict().decision).toBe('allow')
  })

  it('an expired lease stops fencing without anyone releasing it', () => {
    takeLease()
    expect(verdict().decision).toBe('deny')
    const expired = resolveWorkerMutationVerdict({
      db,
      session: owner,
      nowMs: NOW + 31 * 60 * 1000
    })
    expect(expired.decision).toBe('allow')
  })

  it('a release by the wrong owner fails and the fence stays up', () => {
    const leaseId = takeLease()
    expect(
      releaseValidationLease(new ControlPlaneStore(db), {
        scopeKey: validationScopeKeyForWorktree(WORKTREE),
        leaseId,
        owner: 'the_fenced_worker',
        nowMs: NOW + 1000
      })
    ).toEqual({ released: false })
    expect(verdict().decision).toBe('deny')
  })

  it('allows freely when no lease is held at all', () => {
    expect(verdict().decision).toBe('allow')
  })
})

describe('the verdict itself pins the provider session', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  const PANE = 'tab_1:leaf_1'
  const HANDLE = 'term_worker'
  const INCARNATION = 'pty:term_worker'

  /** A REAL active Dispatch in the pane. The resolver in
   *  pretool-gate-runtime-binding screens some of this first, but
   *  `orchestration.mutationVerdict` reaches this function directly, so the
   *  check has to hold here too. */
  function supervised(recordedIncarnation: string = INCARNATION): void {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'build' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: HANDLE,
      paneKey: PANE,
      processIncarnation: recordedIncarnation,
      launchTokenHash: 'hash',
      worktreeId: WORKTREE,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
  }

  const session = (processIncarnation: string | null | undefined): AttestedSession => ({
    terminalHandle: HANDLE,
    paneKey: PANE,
    processIncarnation,
    worktreeId: WORKTREE
  })

  it('NEGATIVE CONTROL: an active Dispatch with NO observed incarnation is refused', () => {
    supervised()
    // Missing is not exempt. A pane key outlives the process in it, so an
    // unidentified session in a supervised pane is exactly the case where the
    // previous Dispatch's answer must not be reused.
    expect(
      resolveWorkerMutationVerdict({ db, session: session(undefined), nowMs: NOW })
    ).toMatchObject({ decision: 'deny', code: 'incarnation_mismatch' })
    expect(resolveWorkerMutationVerdict({ db, session: session(null), nowMs: NOW })).toMatchObject({
      decision: 'deny',
      code: 'incarnation_mismatch'
    })
  })

  it('NEGATIVE CONTROL: a reused pane with an OLD incarnation cannot borrow the answer', () => {
    supervised()
    expect(
      resolveWorkerMutationVerdict({ db, session: session('pty:the-previous-session'), nowMs: NOW })
    ).toMatchObject({ decision: 'deny', code: 'incarnation_mismatch' })
  })

  it('admits the exact observed session when nothing is fenced', () => {
    supervised()
    expect(
      resolveWorkerMutationVerdict({ db, session: session(INCARNATION), nowMs: NOW })
    ).toMatchObject({ decision: 'allow' })
  })
})
