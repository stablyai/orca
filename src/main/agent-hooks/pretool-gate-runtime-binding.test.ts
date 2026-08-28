import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { ControlPlaneStore } from '../runtime/orchestration/control-plane/control-plane-store'
import { acquireValidationLease } from '../runtime/orchestration/control-plane/validation-lease'
import { validationScopeKeyForWorktree } from '../runtime/orchestration/control-plane/validation-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createPretoolMutationResolver } from './pretool-gate-runtime-binding'
import type { PretoolGateRequest } from './pretool-gate'

const WORKTREE = 'repo_a::/work/jb-workflow-control-plane-b'
const PANE = 'tab-1:leaf-1'
const TOKEN = 'launch-token-abc'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

type Placement = {
  terminalHandle: string | null
  processIncarnation: string | null
  worktreeId: string | null
}

/** The resolver the app installs. Everything it keys on is looked up from the
 *  runtime, so these prove a worker cannot state its way past the fence. */
describe('the gate resolver binds runtime-resolved identity only', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  /** A pane really carrying supervised work: the strict attestation rules apply.
   *  `placement` defaults to the truthful one; pass a variant to break exactly
   *  one fact at a time. */
  function supervisedRuntime(
    options: {
      storedTokenHash?: string | null
      placement?: Placement | null
      /** The worktree the DISPATCH is recorded in. Defaults to the fenced one;
       *  set it with `placement` to model a worker genuinely running elsewhere
       *  rather than a record/terminal disagreement. */
      recordedWorktreeId?: string
    } = {}
  ): OrcaRuntimeService {
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
      handle: 'term_worker',
      paneKey: PANE,
      processIncarnation: 'pty:term_worker',
      launchTokenHash:
        options.storedTokenHash === undefined ? TOKEN_HASH : (options.storedTokenHash ?? ''),
      worktreeId: options.recordedWorktreeId ?? WORKTREE,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    const placement =
      options.placement === undefined
        ? {
            terminalHandle: 'term_worker',
            processIncarnation: 'pty:term_worker',
            worktreeId: WORKTREE
          }
        : options.placement
    return {
      getOrchestrationDb: () => db,
      resolveAttestedPanePlacement: (paneKey: string) => (paneKey === PANE ? placement : null)
    } as unknown as OrcaRuntimeService
  }

  /** A pane with no Dispatch at all: an ordinary session. */
  function ordinaryRuntime(): OrcaRuntimeService {
    db = new OrchestrationDb(':memory:')
    return {
      getOrchestrationDb: () => db,
      resolveAttestedPanePlacement: () => null
    } as unknown as OrcaRuntimeService
  }

  function fence(): void {
    acquireValidationLease(new ControlPlaneStore(db), {
      scopeKey: validationScopeKeyForWorktree(WORKTREE),
      leaseId: 'lease_1',
      owner: 'ctx_gate_runner',
      idempotencyKey: 'idem_1',
      nowMs: Date.now()
    })
  }

  const request = (overrides: Partial<PretoolGateRequest> = {}): PretoolGateRequest => ({
    source: 'claude',
    hookEventName: 'PreToolUse',
    toolName: 'Edit',
    paneKey: PANE,
    worktreeId: WORKTREE,
    launchToken: TOKEN,
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Edit' },
    ...overrides
  })

  it('NEGATIVE CONTROL: denies a fully attested session whose workspace is fenced', () => {
    const runtime = supervisedRuntime()
    fence()
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a request naming another workspace cannot dodge the fence', () => {
    // A long-lived shell outlives the environment it was launched with, so the
    // hook body's worktree is never the answer — the runtime's placement is.
    const runtime = supervisedRuntime()
    fence()
    expect(
      createPretoolMutationResolver(runtime)(request({ worktreeId: 'repo_a::/somewhere/else' }))
    ).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a request naming the fenced tree cannot fence an unfenced one', () => {
    const runtime = supervisedRuntime({
      recordedWorktreeId: 'repo_a::/a/disposable/workspace',
      placement: {
        terminalHandle: 'term_worker',
        processIncarnation: 'pty:term_worker',
        worktreeId: 'repo_a::/a/disposable/workspace'
      }
    })
    fence()
    expect(createPretoolMutationResolver(runtime)(request({ worktreeId: WORKTREE }))).toEqual({
      deny: false
    })
  })

  it('NEGATIVE CONTROL: supervised work the runtime cannot place is refused', () => {
    const runtime = supervisedRuntime({ placement: null })
    fence()
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: supervised work with no resolvable workspace is refused', () => {
    const runtime = supervisedRuntime({
      placement: { terminalHandle: 'term_worker', processIncarnation: 'pty:x', worktreeId: null }
    })
    fence()
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a supervised Dispatch with NO stored token hash is refused', () => {
    // An active Dispatch that never recorded a launch token cannot be proven to
    // be the session in this pane. Unproven is not exempt.
    expect(
      createPretoolMutationResolver(supervisedRuntime({ storedTokenHash: null }))(request())
    ).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a supervised call presenting no token is refused', () => {
    expect(
      createPretoolMutationResolver(supervisedRuntime())(request({ launchToken: undefined }))
    ).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a supervised call presenting the wrong token is refused', () => {
    expect(
      createPretoolMutationResolver(supervisedRuntime())(request({ launchToken: 'not-the-token' }))
    ).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a record/terminal workspace disagreement is refused', () => {
    // The Dispatch says one workspace and the live terminal says another. Neither
    // can be preferred, so the runtime cannot say where the mutation lands.
    const runtime = supervisedRuntime({
      placement: {
        terminalHandle: 'term_worker',
        processIncarnation: 'pty:term_worker',
        worktreeId: 'repo_a::/a/disposable/workspace'
      }
    })
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: supervised work with no recorded incarnation is refused', () => {
    const runtime = supervisedRuntime({
      placement: {
        terminalHandle: 'term_worker',
        processIncarnation: null,
        worktreeId: WORKTREE
      }
    })
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('admits the fully attested supervised session when nothing is fenced', () => {
    expect(createPretoolMutationResolver(supervisedRuntime())(request())).toEqual({ deny: false })
  })

  it('lets an ordinary session through, fenced workspace or not', () => {
    // It carries no Dispatch, so there is no supervised work to protect and
    // blocking it would strand real work on any hiccup.
    expect(createPretoolMutationResolver(ordinaryRuntime())(request())).toEqual({ deny: false })
  })

  it('never claims to block a route with no deny channel', () => {
    const runtime = supervisedRuntime()
    fence()
    // Returning deny here would claim a protection that does not exist: the
    // reply is discarded by that provider's hook. Admission refuses instead.
    expect(createPretoolMutationResolver(runtime)(request({ source: 'codex' }))).toEqual({
      deny: false
    })
  })

  it('NEGATIVE CONTROL: a reused pane with a stale incarnation cannot borrow the old answer', () => {
    // The pane key is the same; the process in it is not. Answering for the
    // Dispatch that used to occupy it would hand a replaced provider session
    // the previous one's verdict.
    const runtime = supervisedRuntime({
      placement: {
        terminalHandle: 'term_worker',
        processIncarnation: 'pty:a-different-session',
        worktreeId: WORKTREE
      }
    })
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })

  it('NEGATIVE CONTROL: a control-plane failure denies rather than becoming an allow', () => {
    db = new OrchestrationDb(':memory:')
    const runtime = {
      getOrchestrationDb: () => {
        throw new Error('control plane unavailable')
      },
      resolveAttestedPanePlacement: () => null
    } as unknown as OrcaRuntimeService
    // It cannot even establish whether this pane is supervised, and that is the
    // question that decides how leniently to fail.
    expect(createPretoolMutationResolver(runtime)(request())).toMatchObject({ deny: true })
  })
})
