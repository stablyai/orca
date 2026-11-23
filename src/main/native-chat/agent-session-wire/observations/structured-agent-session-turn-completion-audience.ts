/** Who hears an edge: everyone; only clients that don't take prompts (`legacy`) or only those
 *  that do; or only those that hear held ends. */
export type TurnCompletionAudience = 'all' | 'legacy' | 'prompt-aware' | 'held-aware'

export function hearsTurnCompletionEdge(
  subscriber: { includePrompts?: boolean; includeHeld?: boolean },
  audience: TurnCompletionAudience
): boolean {
  switch (audience) {
    case 'all':
      return true
    case 'legacy':
      return subscriber.includePrompts !== true
    case 'prompt-aware':
      return subscriber.includePrompts === true
    case 'held-aware':
      return subscriber.includeHeld === true
  }
}
