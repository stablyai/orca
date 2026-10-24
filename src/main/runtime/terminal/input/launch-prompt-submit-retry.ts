import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from '../../agent-prompt-submission-verification'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'

export type LaunchPromptSubmitRetryPolicy = { intervalMs: number; attempts: number }

/** The submit-retry policy a fresh launch of `agent` declares, if any. */
export function launchPromptSubmitRetryPolicy(
  agent: TerminalAgent | null
): LaunchPromptSubmitRetryPolicy | undefined {
  return agent ? TUI_AGENT_CONFIG[agent].submitRetryUntilTurnStart : undefined
}

/** A turn start can reach the runtime as a title edge, a hook timestamp, or a status flip. */
export function launchPromptTurnStarted(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return (
    current.workingSequence > baseline.workingSequence ||
    (current.explicitWorkingStartedAt ?? 0) > (baseline.explicitWorkingStartedAt ?? 0) ||
    (current.status === 'working' && baseline.status !== 'working')
  )
}

/**
 * A launch's composer signal can arrive before the TUI can accept Enter: dsh's launchpad paints
 * its `❯` while its startup session is still opening, refuses Enter with "still starting", and
 * keeps the draft. Repeat only Enter until a turn start is observed — the text is already in the
 * composer, so pasting again would be a second turn. Returns the extra submits written.
 */
export async function resubmitLaunchPromptUntilTurnStart(args: {
  policy: LaunchPromptSubmitRetryPolicy
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  writeSubmit: () => boolean
  /**
   * Re-proves the pane still owns the prompt before another Enter: generation, cancellation and
   * the write guard, then one activity read. `false` stops the retries (a turn started or a dialog
   * is up); throwing stops them too, with that error.
   */
  beforeResubmit: () => Promise<boolean>
  failureError?: string
  signal?: AbortSignal
}): Promise<number> {
  let resubmits = 0
  for (;;) {
    const observation = await observeTurnStart(args)
    if (observation !== 'waiting' || resubmits >= args.policy.attempts) {
      return resubmits
    }
    // Why: the guard is async — a cancel, respawn, turn start or dialog can land while it waits.
    if (!(await args.beforeResubmit())) {
      return resubmits
    }
    if (!args.writeSubmit()) {
      throw new Error(args.failureError ?? 'terminal_not_writable')
    }
    resubmits += 1
  }
}

/** A turn start proves Enter landed; a dialog stops the retries rather than typing into it. */
async function observeTurnStart(args: {
  policy: LaunchPromptSubmitRetryPolicy
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  signal?: AbortSignal
}): Promise<'started' | 'waiting' | 'blocked'> {
  try {
    await verifyAgentPromptSubmission({
      baseline: args.baseline,
      readActivity: args.readActivity,
      allowOutputEvidence: false,
      timeoutMs: args.policy.intervalMs,
      ...(args.signal ? { signal: args.signal } : {})
    })
    return 'started'
  } catch (error) {
    if (isAgentPromptStalledError(error)) {
      return 'waiting'
    }
    if (error instanceof Error && error.message === 'agent_prompt_blocked') {
      return 'blocked'
    }
    throw error
  }
}
