/**
 * Whether a `needsAttention` metadata update should fire a native notification.
 * Edge-triggered: only a genuinely new, non-empty reason counts — a caller
 * re-sending the same string (e.g. an unchanged poll result) or clearing the
 * field must not notify.
 */
export function shouldNotifyNeedsAttentionChange(
  previous: string | null | undefined,
  next: string | null | undefined
): next is string {
  return typeof next === 'string' && next.length > 0 && next !== (previous ?? null)
}
