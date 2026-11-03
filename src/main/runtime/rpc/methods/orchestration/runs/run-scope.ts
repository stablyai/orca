import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration-rpc-contract'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RunRow } from '../../../../orchestration/types'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../../../orca-runtime'
import {
  hasRunBindingKey,
  mailboxAddressOf,
  runCoordinatorKey,
  type OrchestrationCallerIdentity,
  type OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import { resolveDeclaredCallerParty } from '../../../../orchestration/orchestration-party'
import {
  findCallerWorkerDispatches,
  unboundWorkerMessage,
  workerRunBindingRefusal
} from '../../../../orchestration/db/runs/worker-run-binding'
import type { OrchestrationDb } from '../../../../orchestration/db'

export type RunScopeParams = {
  runId?: string
  callerTerminalHandle?: string
  callerPaneKey?: string
  /** Resolved at the dispatch entry; when set it is the caller, whatever the declared handle. */
  callerSession: OrchestrationSessionCaller | undefined
  requireCurrentConsumer: boolean
  legacyCoordinatorRunId?: string
  // Attest user-supplied handles against this trusted handle.
  callerEvidence?: OrchestrationCompatibilityEvidence
}

// Mutable Run bindings require attested callers to name only themselves.
export function assertCallerHandleMatchesEvidence(
  runtime: OrcaRuntimeService,
  callerTerminalHandle: string,
  callerEvidence?: OrchestrationCompatibilityEvidence
): void {
  if (!callerEvidence) {
    return
  }
  const attested = runtime.verifyOrchestrationCompatibilityCaller(callerEvidence)
  if (attested && attested.terminalHandle !== callerTerminalHandle) {
    throw new OrchestrationError(
      'consumer_fenced',
      `This terminal is attested as ${attested.terminalHandle} and cannot act as ${callerTerminalHandle}.`,
      { effectsApplied: false }
    )
  }
}

/** Use the dispatch-resolved session outright; otherwise resolve the declared handle's party and pane. */
export function orchestrationCallerIdentity(
  runtime: OrcaRuntimeService,
  caller: {
    handle: string
    paneKey: string | null | undefined
    session: OrchestrationSessionCaller | undefined
  }
): OrchestrationCallerIdentity {
  if (caller.session) {
    return caller.session
  }
  const party = resolveDeclaredCallerParty(caller.handle, runtime.getOrchestrationDb())
  return { ...party, paneKey: caller.paneKey ?? null }
}

export type OrchestrationCallerParams = {
  callerTerminalHandle: string
  callerEvidence?: OrchestrationCompatibilityEvidence
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
  callerSession: OrchestrationSessionCaller | undefined
  /** Preserve legacy callers that treated a missing pane as an ordinary fence. */
  requireStablePane?: boolean
  /** Only skip attestation when the caller does it after the legacy-takeover check (run-use); omitting that reopens impersonation. */
  evidenceAssertedByCaller?: boolean
}

/** Resolve the caller's identity and, by default, attest its declared handle. */
export function resolveOrchestrationCaller(
  runtime: OrcaRuntimeService,
  params: OrchestrationCallerParams & { requireStablePane: true }
): OrchestrationCallerIdentity
export function resolveOrchestrationCaller(
  runtime: OrcaRuntimeService,
  params: OrchestrationCallerParams
): OrchestrationCallerIdentity | null
export function resolveOrchestrationCaller(
  runtime: OrcaRuntimeService,
  params: OrchestrationCallerParams
): OrchestrationCallerIdentity | null {
  if (!params.evidenceAssertedByCaller) {
    assertCallerHandleMatchesEvidence(runtime, params.callerTerminalHandle, params.callerEvidence)
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle: params.callerTerminalHandle,
    session: params.callerSession,
    paneKey:
      params.callerSession === undefined
        ? params.callerAuthority?.terminalHandle === params.callerTerminalHandle
          ? params.callerAuthority.paneKey
          : runtime.getTerminalPaneKey(params.callerTerminalHandle)
        : undefined
  })
  if (!hasRunBindingKey(caller)) {
    if (params.requireStablePane) {
      throw new OrchestrationError(
        'stable_pane_required',
        'The coordinator terminal has no stable pane identity. Run this command inside a live Orca terminal.'
      )
    }
    return null
  }
  return caller
}

const COORDINATOR_RUN_REQUIRED =
  'No Run is bound. A coordinator creates one with `orchestration run-create`, or resumes its own with `orchestration run-use --id <run_id>`.'

// Why: a worker is told where its own mail is, never to bind a Run.
function unboundCallerError(
  db: OrchestrationDb,
  caller: OrchestrationCallerIdentity,
  explicit: RunRow | undefined
): OrchestrationError {
  if (explicit) {
    // Why: consumer_fenced, since a reader that lost this Run mid-check must stop, worker or not.
    const holder = mailboxAddressOf(runCoordinatorKey(explicit))
    return new OrchestrationError(
      'consumer_fenced',
      holder
        ? `This caller is not bound to Run ${explicit.id}, which is bound to ${holder}. Nothing changed.`
        : `This caller does not coordinate Run ${explicit.id}, which has no coordinator now. Nothing changed.`
    )
  }
  const worked = findCallerWorkerDispatches(db, caller)[0]
  return new OrchestrationError(
    'run_required',
    worked ? unboundWorkerMessage(worked) : `${COORDINATOR_RUN_REQUIRED} No effects were applied.`,
    orchestrationSkillRecoveryData()
  )
}

// Why: task and gate mutations must share one Run-binding rule.
export function resolveRunScope(runtime: OrcaRuntimeService, params: RunScopeParams): RunRow {
  const db = runtime.getOrchestrationDb()
  const explicit = params.runId ? db.getRun(params.runId) : undefined
  if (params.runId && (!explicit || explicit.legacy === 1)) {
    throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
  }

  if (!params.requireCurrentConsumer && explicit) {
    return explicit
  }
  if (!params.callerTerminalHandle) {
    throw new OrchestrationError(
      'run_required',
      `${COORDINATOR_RUN_REQUIRED} A worker never binds a Run: its mail arrives through plain \`orchestration check\`, and it reports with \`orchestration send\`. No effects were applied.`,
      orchestrationSkillRecoveryData()
    )
  }
  assertCallerHandleMatchesEvidence(runtime, params.callerTerminalHandle, params.callerEvidence)
  if (explicit && params.legacyCoordinatorRunId === explicit.id) {
    return explicit
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle: params.callerTerminalHandle,
    session: params.callerSession,
    paneKey:
      params.callerSession === undefined
        ? (params.callerPaneKey ?? runtime.getTerminalPaneKey(params.callerTerminalHandle))
        : undefined
  })
  if (!hasRunBindingKey(caller)) {
    throw new OrchestrationError(
      'stable_pane_required',
      'The coordinator terminal has no stable pane identity.'
    )
  }
  const run = explicit
    ? db.getCoordinatedRun(caller, explicit.id)
    : db.getCurrentRunForCoordinator(caller)
  if (run) {
    return run
  }
  // A worker naming its own or ancestor Run needs its Dispatch mailbox, not a binding change.
  const workerRefusal = explicit
    ? workerRunBindingRefusal(db, caller, explicit.id, { takeover: false, bind: false })
    : null
  if (workerRefusal) {
    throw workerRefusal
  }
  const current = explicit ? db.getCurrentRunForCoordinator(caller) : undefined
  if (!explicit || !current) {
    throw unboundCallerError(db, caller, explicit)
  }
  throw new OrchestrationError(
    'consumer_fenced',
    `This caller is bound to Run ${current.id}, not Run ${explicit.id}. Nothing changed.`
  )
}
