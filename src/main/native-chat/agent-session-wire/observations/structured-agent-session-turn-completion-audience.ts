/** Who hears an edge: everyone; only clients that don't take prompts (`legacy`) or only those
 *  that do; only those that hear held ends, or only those that don't (an end they heard held). */
export type TurnCompletionAudience =
  | 'all'
  | 'legacy'
  | 'prompt-aware'
  | 'held-aware'
  | 'held-unaware'

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
