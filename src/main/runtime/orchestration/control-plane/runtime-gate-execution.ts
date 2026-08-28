import { createHash } from 'node:crypto'
import {
  runProcess,
  runProcessSync,
  type ProcessResult
} from '../../../../shared/child-process/run-process'
import type { ControlPlaneStore, GateExecutionRow } from './control-plane-store'
import { recordGateReceipt, type GateShaBinding } from './gate-receipt-validity'

/** Blocker 1 - a gate result is evidence only when the RUNTIME ran the gate.
 *
 *  `orchestration gates --record --result PASS` let a caller name the gate, the
 *  SHA and the verdict without anything ever executing. This runs the declared
 *  command through the approved process wrapper and records what actually
 *  happened: the command, the exit code, and a digest of the output. A PASS
 *  with no successful row here is a claim, not a receipt.
 */

export type GateExecutionRequest = {
  scopeKey: string
  gateId: string
  finalSha: string
  program: string
  args: readonly string[]
  cwd: string
  buildId: string
  runId: string
  outcomeId: string
  dispatchId: string
  worktreeId: string
  policyVersion: string
  commandIdentity: string
  specHash: string
  inputHashes: Readonly<Record<string, string>>
  shaBinding: GateShaBinding
  timeoutMs?: number
  /** Re-observe the authoritative tree after the process exits and before any
   * PASS row is persisted. A non-null reason converts the execution to FAIL. */
  validateAfter?: () => string | null
}

export type GateExecutionResult = {
  execution: GateExecutionRow
  passed: boolean
  validationFailure: string | null
  /** Production gate callers may release their mutation fence only when this
   * is true. The synchronous fixture path has no such proof. */
  processTreeVerified?: boolean
}

function digest(stdout: string, stderr: string): string {
  return createHash('sha256').update(stdout).update(stderr).digest('hex').slice(0, 32)
}

export function runGate(
  store: ControlPlaneStore,
  request: GateExecutionRequest
): GateExecutionResult {
  const startedAt = new Date().toISOString()
  const result = runProcessSync({
    program: request.program,
    args: [...request.args],
    cwd: request.cwd,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
  })
  const validationFailure = request.validateAfter?.() ?? null
  return persistGateExecution(store, request, result, startedAt, validationFailure, false)
}

/** Production gate execution. The detached process group is forced quiescent
 * even after a zero exit so a daemonized test child cannot outlive the fence. */
export async function runGateWithBarrier(
  store: ControlPlaneStore,
  request: GateExecutionRequest
): Promise<GateExecutionResult> {
  const startedAt = new Date().toISOString()
  const result = await runProcess({
    program: request.program,
    args: [...request.args],
    cwd: request.cwd,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    terminationBarrier: true
  })
  const processTreeVerified = result.terminationVerified === true
  const validationFailure = processTreeVerified
    ? (request.validateAfter?.() ?? null)
    : 'The required gate process tree did not reach verified terminal exit.'
  return persistGateExecution(
    store,
    request,
    result,
    startedAt,
    validationFailure,
    processTreeVerified
  )
}

function persistGateExecution(
  store: ControlPlaneStore,
  request: GateExecutionRequest,
  result: ProcessResult,
  startedAt: string,
  validationFailure: string | null,
  processTreeVerified: boolean
): GateExecutionResult {
  const finishedAt = new Date().toISOString()
  const command = [request.program, ...request.args].join(' ')
  const execution: GateExecutionRow = {
    execution_id: createHash('sha256')
      .update(request.scopeKey)
      .update(request.gateId)
      .update(request.finalSha)
      .update(startedAt)
      .digest('hex')
      .slice(0, 32),
    scope_key: request.scopeKey,
    gate_id: request.gateId,
    final_sha: request.finalSha,
    command,
    // Why a timeout is a non-zero failure rather than null: a gate the runtime
    // had to kill did not pass, and must never read as "unknown".
    exit_code: validationFailure ? 125 : result.timedOut ? 124 : result.code,
    log_digest: digest(
      result.stdout,
      validationFailure ? `${result.stderr}\n${validationFailure}` : result.stderr
    ),
    build_id: request.buildId,
    started_at: startedAt,
    finished_at: finishedAt
  }
  store.recordGateExecution(execution)
  store.recordGateExecutionAuthority({
    execution_id: execution.execution_id,
    run_id: request.runId,
    outcome_id: request.outcomeId,
    dispatch_id: request.dispatchId,
    worktree_id: request.worktreeId,
    build_id: request.buildId,
    policy_version: request.policyVersion,
    command_identity: request.commandIdentity,
    spec_hash: request.specHash,
    input_hashes: JSON.stringify(request.inputHashes)
  })
  recordGateReceipt(store, {
    scopeKey: request.scopeKey,
    inputs: {
      gateId: request.gateId,
      finalSha: request.finalSha,
      inputHashes: request.inputHashes,
      policyVersion: request.policyVersion,
      commandIdentity: request.commandIdentity,
      shaBinding: request.shaBinding
    },
    result: execution.exit_code === 0 ? 'PASS' : 'FAIL',
    recordedAt: finishedAt
  })
  return {
    execution,
    passed: execution.exit_code === 0,
    validationFailure,
    processTreeVerified
  }
}

/** True when the runtime itself observed this exact gate succeed at this exact
 *  commit. The completion gate requires it before a PASS means anything. */
export function hasRuntimeProvenGate(
  store: ControlPlaneStore,
  args: {
    scopeKey: string
    gateId: string
    finalSha: string
    buildId: string
    runId: string
    outcomeId: string
    dispatchId: string
    worktreeId: string
    specHash: string
    inputHashes: Readonly<Record<string, string>>
    /** Content gates can survive a new SHA; exact-head gates cannot. */
    shaBinding: GateShaBinding
    riskPolicy?: 'standard' | 'high_risk'
  }
): boolean {
  const { finalSha, dispatchId, shaBinding, riskPolicy, inputHashes, ...commonAuthority } = args
  const exactHead = shaBinding === 'exact_head' || riskPolicy === 'high_risk'
  return (
    store.findSuccessfulGateExecution({
      ...commonAuthority,
      inputHashes: JSON.stringify(inputHashes),
      // High-risk and final-head gates must have run for this exact Dispatch at
      // this exact SHA. Standard content gates may reuse the same runtime-owned
      // execution only when every byte/config fingerprint is identical.
      ...(exactHead ? { finalSha, dispatchId } : {})
    }) !== undefined
  )
}
