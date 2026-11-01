import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-create-contract'
/**
 * What becomes of a launch's initial text, and what the receipt is allowed to say about it.
 *
 * Split from the executor because they answer different questions. The executor decides WHICH
 * surface exists and in what order; everything here decides how the text reaches whichever surface
 * that turned out to be, and each surface takes it differently:
 *
 *   structured session   ->  committed to the transcript, named by a message id  ->  journaled
 *   terminal, line fits  ->  folded into the command that execs the agent        ->  handed-to-terminal
 *   terminal, otherwise  ->  bracketed paste into the live PTY once it is ready  ->  handed-to-terminal
 *   proven message noncommit or terminal refusal                              ->  not-delivered
 *   a committed message whose row cannot yet be read, or interrupted delivery ->  unconfirmed
 *
 * argv has no readiness race, so it is offered wherever the agent's CLI takes a prompt argument
 * (`agentPromptRidesLaunchCommand`). But that command is TYPED into the user's shell, and a long or
 * multi-line typed line fails in ways argv itself does not, so whether the offer was taken is decided
 * where the line is built (`startup-line-prompt-carry`) and reported back, never predicted here.
 */

import type {
  AgentLaunchIntent,
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../shared/agent-launch-intent'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import type { CreatedSurface } from './agent-launch-surface-creation'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'

export const HANDED_TO_TERMINAL: AgentLaunchPromptDisposal = { outcome: 'handed-to-terminal' }
const NOT_DELIVERED: AgentLaunchPromptDisposal = { outcome: 'not-delivered' }
const UNCONFIRMED: AgentLaunchPromptDisposal = { outcome: 'unconfirmed' }

/** Persist owed submits as unconfirmed: a crash during delivery must not invite duplicate turns. */
export function settledAtCreation(
  intent: Pick<AgentLaunchIntent, 'prompt'>,
  created: Pick<CreatedSurface, 'promptRodeLaunchCommand' | 'structured'>
): AgentLaunchPromptDisposal {
  if (created.structured?.promptDisposal) {
    return created.structured.promptDisposal
  }
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  return intent.prompt?.delivery === 'submit' ? UNCONFIRMED : NOT_DELIVERED
}

export async function settleLaunchPromptDisposal(
  execution: AgentLaunchSurfaceExecution,
  created: CreatedSurface
): Promise<AgentLaunchPromptDisposal> {
  if (created.structured) {
    return settledAtCreation(execution.intent, created)
  }
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  return deliverTerminalLaunchPrompt(execution, created.outcome.handle, {
    freshLaunch: true,
    terminalCreation: created.terminalCreation
  })
}

/** PTY writes prove handoff, not consumption; drafts remain undelivered because acceptance is unobservable. */
export async function deliverTerminalLaunchPrompt(
  execution: AgentLaunchSurfaceExecution,
  handle: string,
  {
    freshLaunch,
    terminalCreation
  }: { freshLaunch: boolean; terminalCreation?: RuntimeTerminalCreate }
): Promise<AgentLaunchPromptDisposal> {
  const { intent, surfaces, signal } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit' || signal?.aborted) {
    return NOT_DELIVERED
  }
  const delivered = await surfaces.deliverTerminalPrompt?.({
    handle,
    agent: intent.agent,
    freshLaunch,
    terminalCreation,
    prompt: intent.prompt,
    ...(signal ? { signal } : {})
  })
  return delivered ? HANDED_TO_TERMINAL : NOT_DELIVERED
}

function launchSubmitText(intent: AgentLaunchIntent): string | undefined {
  return intent.prompt?.delivery === 'submit' && intent.prompt.text ? intent.prompt.text : undefined
}

/** Offer argv prompts; only the surface building the typed line can confirm that they fit. */
export function argvLaunchPrompt(intent: AgentLaunchIntent): string | undefined {
  const text = launchSubmitText(intent)
  return text && agentPromptRidesLaunchCommand(intent.agent) ? text : undefined
}

/** Only terminal creates can carry text on their launch command. */
export function launchCommandPrompt(
  intent: AgentLaunchIntent,
  mode: AgentLaunchModeReceipt['mode']
): string | undefined {
  return mode === 'terminal' ? argvLaunchPrompt(intent) : undefined
}

/**
 * The one place a receipt is built, so a disposal cannot be reported without the delivery it
 * belongs to.
 *
 * Each arm is a consequence of the act it names, never a write-ahead of it: `journaled` is
 * reachable only from a committed message id, `handed-to-terminal` only from a launch command that
 * carried the text or a PTY write that returned. Unreadable committed proof stays `unconfirmed`;
 * the submission itself records whether a provider received the accepted message.
 */
export function promptReceipt(
  intent: AgentLaunchIntent,
  disposal: AgentLaunchPromptDisposal
): Pick<AgentLaunchResult, 'prompt'> {
  if (!intent.prompt) {
    return {}
  }
  return { prompt: { delivery: intent.prompt.delivery, ...disposal } }
}
