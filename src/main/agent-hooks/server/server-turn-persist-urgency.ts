import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { CLAUDE_LATE_PROMPT_SUBMIT_EVENT } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-prompt-turn-order'

/** Prompt, turn-opening and completion facts a restart restores even while the lead's turn
 *  state stays put (a late Stop, a repeated prompt); they must not wait for the batched save. */
export function turnFactsChanged(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  return (
    // Submitted prompts, even Claude's late ones, skip the checkpoint; terminal-derived prompt streams do not.
    ((next.hookEventName === 'UserPromptSubmit' ||
      next.hookEventName === CLAUDE_LATE_PROMPT_SUBMIT_EVENT ||
      next.hasExplicitPrompt === true) &&
      next.payload.prompt !== previous?.payload.prompt) ||
    // A new turn may repeat its prompt; opening it is the fact a crash must not lose.
    (next.payload.state === 'working' && previous?.payload.state !== 'working') ||
    (next.payload.mainAgent?.state === 'working' &&
      previous?.payload.mainAgent?.state !== 'working') ||
    ((next.payload.state === 'done' ||
      next.payload.mainAgent?.state === 'done' ||
      next.payload.turnCompletedAt !== undefined) &&
      (next.payload.state !== previous?.payload.state ||
        next.payload.turnCompletedAt !== previous?.payload.turnCompletedAt ||
        next.payload.mainAgent?.state !== previous?.payload.mainAgent?.state ||
        next.payload.mainAgent?.outcome !== previous?.payload.mainAgent?.outcome ||
        next.payload.interrupted !== previous?.payload.interrupted ||
        next.turnEndedAt !== previous?.turnEndedAt ||
        next.payload.lastAssistantMessage !== previous?.payload.lastAssistantMessage))
  )
}
