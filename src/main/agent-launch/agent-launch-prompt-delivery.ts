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
 *   anything unproven    ->                                                      ->  not-delivered
 *   host stopped mid-delivery (a replayed record only)                         ->  unconfirmed
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
import type { CreatedSurface } from './agent-launch-executor'
import type { AgentLaunchSurfaceExecution } from './agent-launch-execution'
import type { AgentLaunchStructuredSurface } from './agent-launch-surface-factories'

export const HANDED_TO_TERMINAL: AgentLaunchPromptDisposal = { outcome: 'handed-to-terminal' }
const NOT_DELIVERED: AgentLaunchPromptDisposal = { outcome: 'not-delivered' }
const UNCONFIRMED: AgentLaunchPromptDisposal = { outcome: 'unconfirmed' }

/**
 * What the record may say before any delivery runs: only what creating the surface already settled.
 * A launch command that carried the text has handed it over, and a draft is never delivered by the
 * host. A submit still owed is `unconfirmed`: a host that stops mid-delivery cannot say whether the
 * paste or the commit landed, and "not delivered" would invite a duplicate turn.
 */
export function settledAtCreation(
  intent: Pick<AgentLaunchIntent, 'prompt'>,
  created: { promptRodeLaunchCommand?: boolean }
): AgentLaunchPromptDisposal {
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  return intent.prompt?.delivery === 'submit' ? UNCONFIRMED : NOT_DELIVERED
}

/** Each surface delivers its own way, so the disposal is decided where the surface is known. */
export async function settleLaunchPromptDisposal(
  execution: AgentLaunchSurfaceExecution,
  created: CreatedSurface
): Promise<AgentLaunchPromptDisposal> {
  if (created.structured) {
    const messageId = await deliverStructuredLaunchPrompt(execution, created.structured)
    return messageId ? { outcome: 'journaled', messageId } : NOT_DELIVERED
  }
  // The surface reported that the startup command carried the prompt; there is nothing left to write.
  if (created.promptRodeLaunchCommand) {
    return HANDED_TO_TERMINAL
  }
  return deliverTerminalLaunchPrompt(execution, created.outcome.handle, { freshLaunch: true })
}

/**
 * Commits the launch text to a structured session's transcript.
 *
 * `draft` is excluded: a structured draft belongs in the composer, and the host has none.
 */
async function deliverStructuredLaunchPrompt(
  execution: AgentLaunchSurfaceExecution,
  structured: AgentLaunchStructuredSurface
): Promise<string | null> {
  const { intent, surfaces } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit') {
    return null
  }
  return (
    (await surfaces.deliverStructuredPrompt?.({
      sessionId: structured.sessionId,
      fence: structured.fence,
      prompt: intent.prompt
    })) ?? null
  )
}

/**
 * Writes the launch text into a terminal agent that is already running.
 *
 * The host owns the PTY, so it is better placed to write into one than the renderer that used to:
 * a pane owner can only deliver while its own window is open, which is why mobile and the CLI
 * never got a terminal prompt at all. What the host cannot see is what the agent then does with
 * it — a terminal keeps no transcript — so this reports `handed-to-terminal`, never `journaled`.
 *
 * `draft` stays `not-delivered`. A terminal draft is unsent text sitting in the TUI's own
 * composer; the host could paste it without a submit, but it has no way to observe that the
 * composer accepted it, so a receipt claiming delivery would be a guess.
 */
export async function deliverTerminalLaunchPrompt(
  execution: AgentLaunchSurfaceExecution,
  handle: string,
  { freshLaunch }: { freshLaunch: boolean }
): Promise<AgentLaunchPromptDisposal> {
  const { intent, surfaces } = execution
  if (!intent.prompt || intent.prompt.delivery !== 'submit') {
    return NOT_DELIVERED
  }
  const delivered = await surfaces.deliverTerminalPrompt?.({
    handle,
    agent: intent.agent,
    freshLaunch,
    prompt: intent.prompt
  })
  return delivered ? HANDED_TO_TERMINAL : NOT_DELIVERED
}

/** The launch text that has to reach a surface, or undefined when there is none to deliver. */
function launchSubmitText(intent: AgentLaunchIntent): string | undefined {
  return intent.prompt?.delivery === 'submit' && intent.prompt.text ? intent.prompt.text : undefined
}

/**
 * The prompt offered to a terminal's launch command, which is an argv-mode agent's and only an
 * argv-mode agent's. An offer, not a decision: the surface reports whether the typed line took it.
 */
export function argvLaunchPrompt(intent: AgentLaunchIntent): string | undefined {
  const text = launchSubmitText(intent)
  return text && agentPromptRidesLaunchCommand(intent.agent) ? text : undefined
}

/** The same question before a surface exists, where a structured create must carry no prompt: its
 *  text is journaled into the session afterwards, not folded into a command. */
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
 * carried the text or a PTY write that returned, and everything else under-claims as
 * `not-delivered`. A live answer has no "maybe": `unconfirmed` is written only into the record
 * before delivery runs (`settledAtCreation`), and is read back only by a replay. The one live
 * exception never reaches the wire: a `legacy-host` create's unawaited post-start send
 * (agent-launch-legacy-host.ts). Dispatch doubt is not this tier's to report: the submission row
 * carries it.
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
