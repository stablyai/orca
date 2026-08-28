import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { runGate } from '../../orchestration/control-plane/runtime-gate-execution'
import { observeCompletion } from '../../orchestration/control-plane/runtime-observed-completion'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

/** The verb that makes a completion receipt mean something.
 *
 *  `gates --record --result PASS` lets a caller name a gate, a SHA and a verdict
 *  with nothing having executed. This runs the command through the approved
 *  process wrapper and records what actually happened, so the completion gate
 *  has something real to require. Without it the gate can only ever be FAILED,
 *  never satisfied — which is a rejection machine, not a control plane.
 */

export const GateRunParams = z.object({
  dispatch: requiredString('--dispatch'),
  gate: requiredString('--gate'),
  program: requiredString('--program'),
  args: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  run: OptionalString,
  from: OptionalString
})

export function runGateForDispatch(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  gateId: string
  program: string
  args?: string
  timeoutMs?: number
  /** The receiving runtime's pinned build identity. Passed in, never resolved
   *  here: one process must have exactly one build identity, and a module that
   *  resolves its own is a second authority that can disagree with it. */
  buildId: string
}): {
  gate: string
  sha: string
  passed: boolean
  exitCode: number | null
  command: string
  logDigest: string
} {
  const store = new ControlPlaneStore(args.db)
  const binding = resolveOutcomeBinding(store, args.runId)
  // Why the runtime resolves both the tree and the SHA: the point of this verb
  // is that they are observed, not stated. A caller naming either could record a
  // passing gate against a commit it never ran on.
  const observed = observeCompletion({ db: args.db, dispatchId: args.dispatchId })
  if (!observed.observable || !observed.headSha || !observed.worktreePath) {
    throw new OrchestrationError(
      'gate_tree_unobservable',
      observed.reason ??
        `The runtime cannot read the tree for Dispatch ${args.dispatchId}, so it cannot run a gate there.`
    )
  }
  const result = runGate(store, {
    scopeKey: `${args.runId}:${binding.kind === 'admitted' ? binding.outcome.outcome_id : 'unbound'}`,
    gateId: args.gateId,
    finalSha: observed.headSha,
    program: args.program,
    args: args.args ? args.args.split(' ').filter(Boolean) : [],
    cwd: observed.worktreePath,
    buildId: args.buildId,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
  })
  return {
    gate: args.gateId,
    sha: observed.headSha,
    passed: result.passed,
    exitCode: result.execution.exit_code,
    command: result.execution.command,
    logDigest: result.execution.log_digest
  }
}
