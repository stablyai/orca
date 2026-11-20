import type { AgentPromptSentDedupeEntry } from './server-types'

type PromptSentObservation = AgentPromptSentDedupeEntry & {
  /** A person's prompt that joined an already open Claude turn. */
  late: boolean
  previousState: string | undefined
  state: string
}

/** One sent prompt can reach telemetry more than once; same-text reruns across a finished turn still count. */
export function isDuplicatePromptSent(
  previous: AgentPromptSentDedupeEntry | undefined,
  next: PromptSentObservation
): boolean {
  if (previous?.agentKind !== next.agentKind) {
    return false
  }
  // A late prompt never crosses a turn boundary; its turn's prompt_id and text identify it.
  if (next.late) {
    return (
      previous.promptHash === next.promptHash && previous.providerPromptId === next.providerPromptId
    )
  }
  if (
    previous.promptInteractionKey !== undefined &&
    previous.promptInteractionKey === next.promptInteractionKey &&
    (next.agentKind === 'opencode' || previous.promptHash === next.promptHash)
  ) {
    return true
  }
  return (
    previous.promptHash === next.promptHash &&
    !(
      next.previousState === 'done' &&
      next.state === 'done' &&
      previous.promptInteractionKey !== undefined &&
      next.promptInteractionKey !== undefined &&
      previous.promptInteractionKey !== next.promptInteractionKey
    ) &&
    !(next.previousState === 'done' && next.state === 'working')
  )
}
