import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/**
 * Turn-start verdict for a dispatched worker prompt, in the execution-boundary vocabulary:
 *
 * - 'observed': the provider proved a turn started for this request. Positive liveness.
 * - 'permission': the agent rendered an approval prompt after the write. Positive liveness,
 *   but the turn is blocked on a human.
 * - 'unsupported': this provider exposes no turn-start signal; the accepted write is the
 *   strongest receipt that can exist. Never treated as failure.
 * - 'unobserved': observation IS supported and no turn started within the window. This is
 *   `unverifiable`, never evidence of death — the bytes were written, but the agent may be
 *   wedged at startup or holding the spec unsent in its composer.
 */
export type WorkerTurnStartVerdict = 'observed' | 'permission' | 'unsupported' | 'unobserved'

export type WorkerTurnStartObservation = {
  verdict: WorkerTurnStartVerdict
  prompt?: RuntimeTerminalPromptDelivery
}

function classifyPromptDelivery(prompt: RuntimeTerminalPromptDelivery): WorkerTurnStartVerdict {
  if (prompt.stages.includes('turn_started')) {
    return 'observed'
  }
  if (prompt.observation === 'permission') {
    return 'permission'
  }
  if (prompt.observation === 'supported') {
    return 'unobserved'
  }
  // 'unsupported' (and an old host's missing observation) leaves acceptance as the best receipt.
  return 'unsupported'
}

/**
 * Second-stage turn-start observation for a worker prompt that was accepted without waiting on
 * provider hooks. Reuses the same observer that terminal.send receipts replay through, so the
 * evidence rules (lifecycle edge or hook turn-start, never output bytes) stay in one place.
 *
 * The observation window is `AGENT_PROMPT_EFFECT_TIMEOUT_MS`, which worker-start's client RPC
 * grace already budgets for (see orchestration-worker-start-prompt-budget.ts).
 */
export async function observeWorkerTurnStart(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  prompt: RuntimeTerminalPromptDelivery | undefined
  timeoutMs?: number
}): Promise<WorkerTurnStartObservation> {
  if (!args.prompt) {
    return { verdict: 'unsupported' }
  }
  const verdict = classifyPromptDelivery(args.prompt)
  if (verdict !== 'unobserved') {
    return { verdict, prompt: args.prompt }
  }
  let observed: RuntimeTerminalPromptDelivery
  try {
    observed = await args.runtime.observeTerminalAgentPrompt(
      args.terminalHandle,
      args.prompt,
      args.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS
    )
  } catch {
    // Observation failure cannot revoke authority for input that was already accepted.
    return { verdict: 'unobserved', prompt: args.prompt }
  }
  if (observed.observation === 'incarnation_replaced') {
    // The PTY under this handle changed mid-observation; the accepted write is unproven.
    return { verdict: 'unobserved', prompt: observed }
  }
  return { verdict: classifyPromptDelivery(observed), prompt: observed }
}

export function describeUnobservedWorkerTurnStart(agent: string | null): string {
  const name = agent ?? 'the agent'
  return (
    `Dispatch input was written and submitted, but ${name}'s turn start could not be verified ` +
    `during observation (up to ${Math.round(AGENT_PROMPT_EFFECT_TIMEOUT_MS / 1000)}s). This is unverifiable, not proof the ` +
    'worker is dead: the agent may still be starting, may be wedged (for example waiting on ' +
    'network), or may be holding the task unsent in its composer. If the worker recovers and ' +
    'reports, this Dispatch settles normally.'
  )
}
