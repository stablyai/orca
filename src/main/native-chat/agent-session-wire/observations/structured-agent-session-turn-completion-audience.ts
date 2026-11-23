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
    case 'held-unaware':
      return subscriber.includeHeld !== true
  }
}

/** A held end goes only to those who hear held ends, and not to them again once announced; a clean
 *  end that restates a prompt goes only to clients that don't take prompts. */
export function completionAudience(end: {
  held?: boolean
  restatesPrompt: boolean
  told?: boolean
}): TurnCompletionAudience {
  return end.held ? 'held-aware' : end.restatesPrompt ? 'legacy' : end.told ? 'held-unaware' : 'all'
}
