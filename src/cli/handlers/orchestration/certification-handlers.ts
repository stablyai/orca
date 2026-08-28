import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'

/** Local to keep the flag's accepted values next to the verb that accepts them. */
function requireDecision(value: string): 'allow' | 'block' {
  if (value !== 'allow' && value !== 'block') {
    throw new RuntimeClientError(
      'invalid_argument',
      `--decision must be allow or block; received ${value}.`
    )
  }
  return value
}
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

/** The two verbs that make certification reachable at all: one has the runtime
 *  execute a gate so a receipt has something real behind it, the other mints the
 *  single-use intent that permits a never-certified route's first launch. */
export const ORCHESTRATION_CERTIFICATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration pretool-receipt': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      receipt: { receipt_id: string; dispatch_id: string; decision: string }
    }>(client, flags, 'orchestration.pretoolReceipt', {
      decision: requireDecision(getRequiredStringFlag(flags, 'decision')),
      policy: getRequiredStringFlag(flags, 'policy'),
      policyVersion: getRequiredStringFlag(flags, 'policy-version'),
      tool: getOptionalStringFlag(flags, 'tool'),
      reason: getOptionalStringFlag(flags, 'reason'),
      from: await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    })
    printResult(
      result,
      json,
      (value) =>
        `Recorded ${value.receipt.decision} receipt ${value.receipt.receipt_id} for ${value.receipt.dispatch_id}`
    )
  },

  'orchestration gate-run': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      gate: string
      sha: string
      passed: boolean
      exitCode: number | null
      command: string
      logDigest: string
    }>(client, flags, 'orchestration.gateRun', {
      dispatch: getRequiredStringFlag(flags, 'dispatch'),
      gate: getRequiredStringFlag(flags, 'gate'),
      program: getRequiredStringFlag(flags, 'program'),
      args: getOptionalStringFlag(flags, 'args'),
      timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    })
    printResult(
      result,
      json,
      (value) =>
        `${value.passed ? 'PASS' : 'FAIL'} ${value.gate} at ${value.sha} (exit ${value.exitCode}) :: ${value.command}`
    )
  },

  'orchestration certification-intent': async ({ flags, client, cwd, json }) => {
    const result = await callOrchestrationMutation<{
      intent: { intent_id: string; run_id: string; task_id: string; worktree_id: string }
    }>(client, flags, 'orchestration.certificationIntent', {
      run: getOptionalStringFlag(flags, 'run'),
      task: getRequiredStringFlag(flags, 'task'),
      worktree: getRequiredStringFlag(flags, 'worktree'),
      agent: getRequiredStringFlag(flags, 'agent'),
      model: getOptionalStringFlag(flags, 'model'),
      reasoning: getOptionalStringFlag(flags, 'reasoning'),
      from: await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    })
    printResult(
      result,
      json,
      (value) =>
        `Minted ${value.intent.intent_id} for task ${value.intent.task_id} in ${value.intent.worktree_id}`
    )
  }
}
