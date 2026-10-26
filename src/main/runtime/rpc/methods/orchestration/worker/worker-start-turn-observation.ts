import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** Observed/permission prove live input handling; unsupported keeps accepted-write evidence.
 * Unobserved means supported observation timed out after write: unverifiable, never dead, and no safe blind resend. */
export type WorkerTurnStartVerdict = 'observed' | 'permission' | 'unsupported' | 'unobserved'

export type WorkerTurnStartObservation = {
  verdict: WorkerTurnStartVerdict
  prompt?: RuntimeTerminalPromptDelivery
  /** Why an `unobserved` start is unknown, when the default PTY wording does not fit. */
  reason?: string
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

/** Reuse terminal.send's lifecycle/hook observer, never output bytes; client grace already includes AGENT_PROMPT_EFFECT_TIMEOUT_MS. */
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
