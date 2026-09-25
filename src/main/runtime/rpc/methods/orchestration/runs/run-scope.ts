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
  type OrchestrationCallerIdentity,
  type OrchestrationSessionCaller
} from '../../../../orchestration/orchestration-caller-identity'
import { resolveDeclaredCallerParty } from '../../../../orchestration/orchestration-party'

export type RunScopeParams = {
  runId?: string
  callerTerminalHandle?: string
  callerPaneKey?: string
  /** Resolved at the dispatch entry; when set it is the caller, whatever the declared handle. */
  callerSession: OrchestrationSessionCaller | undefined
  requireCurrentConsumer: boolean
  legacyCoordinatorRunId?: string
  // Why: the caller's declared handle is a user param; this is the attested one to check it against.
  callerEvidence?: OrchestrationCompatibilityEvidence
}

// Why: declared handles select mutable Run bindings, so attested callers may only name themselves.
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

/**
 * The caller as Run binding and mail routing see it. A session the dispatch entry resolved is the
 * caller outright; otherwise it is the party the declared handle names, at the pane it resolved to.
 */
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
  /**
   * Skip attestation here because the caller performs it itself — run-use must run
   * its legacy-takeover check between pane resolution and attestation. Setting this
   * without asserting elsewhere reopens the hole this helper exists to close.
   */
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
      'No Run is bound. Use orchestration run-create or run-use first. No effects were applied.',
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
  const current = db.getCurrentRunForCoordinator(caller)
  if (!current) {
    if (explicit) {
      throw new OrchestrationError(
        'consumer_fenced',
        `This coordinator terminal is no longer bound to Run ${explicit.id}.`
      )
    }
    throw new OrchestrationError(
      'run_required',
      'No Run is bound. Use orchestration run-create or run-use first. No effects were applied.',
      orchestrationSkillRecoveryData()
    )
  }
  if (explicit && current.id !== explicit.id) {
    throw new OrchestrationError(
      'consumer_fenced',
      `This coordinator terminal is bound to ${current.id}, not ${explicit.id}.`
    )
  }
  return current
}
