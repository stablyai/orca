import type { EnrichedAgentHookEventPayload } from './server-types'

/** Prompt, turn-opening and completion facts must not wait for the routine stream checkpoint. */
export function turnFactsNeedUrgentPersist(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: EnrichedAgentHookEventPayload
): boolean {
  return (
    next.payload.prompt !== previous?.payload.prompt ||
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
