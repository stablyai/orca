import { createHash } from 'node:crypto'
import { runProcessSync } from '../../../../shared/child-process/run-process'
import type { ControlPlaneStore, GateExecutionRow } from './control-plane-store'

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
  timeoutMs?: number
}

export type GateExecutionResult = {
  execution: GateExecutionRow
  passed: boolean
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
    exit_code: result.timedOut ? 124 : result.code,
    log_digest: digest(result.stdout, result.stderr),
    build_id: request.buildId,
    started_at: startedAt,
    finished_at: finishedAt
  }
  store.recordGateExecution(execution)
  return { execution, passed: execution.exit_code === 0 }
}

/** True when the runtime itself observed this exact gate succeed at this exact
 *  commit. The completion gate requires it before a PASS means anything. */
export function hasRuntimeProvenGate(
  store: ControlPlaneStore,
  args: { scopeKey: string; gateId: string; finalSha: string }
): boolean {
  return store.findSuccessfulGateExecution(args) !== undefined
}
