import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'

// zcode's goal-write confirmation event; the typed state is what the options read reports as the
// current goal. Pause/resume/clear pushes are not observed events, so their rows lag until the
// next goalSet.

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The typed goal row a `goalSet` event journals; nothing when the objective is unreadable. */
export function zcodeGoalSetEvents(
  providerSessionId: string,
  payload: unknown,
  at: number
): ProviderTimelineEvent[] {
  const objective = readString(readRecord(payload)?.objective)?.trim()
  if (!objective) {
    return []
  }
  return [
    {
      type: 'item.open',
      item: `${providerSessionId}:goal:${at}`,
      body: {
        kind: 'status',
        text: `Goal set: ${objective}`,
        threadGoal: {
          state: 'set',
          goal: {
            objective,
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: at,
            updatedAt: at
          }
        }
      },
      join: { thread: providerSessionId }
    }
  ]
}
