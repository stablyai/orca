import { RECENT_FAMILY_CAP, boundedSends, type Send } from './journal-operation-window-sends'
import type { JournalSqlScope } from './journal-sql-scope'

/** The unsettled `seed` with its families, or null once a send the window must hold sits before the
 *  `newest` turns: the whole read is cheaper than reading by index the stretch it pins the window to.
 *  Each family member of a held unanswered send is held, so the first older one ends the walk. */
export function recentSends(
  scope: JournalSqlScope,
  seed: Send[],
  operations: ReadonlySet<string>,
  earliest: number | null,
  newest: number,
  anchorsOnly: boolean
): Send[] | null {
  const older = (send: Send) => !anchorsOnly && reachesBefore([send], null, newest)
  if ((earliest ?? Infinity) < newest || seed.some(older)) {
    return null
  }
  const sends = boundedSends(scope, [], seed, { cap: RECENT_FAMILY_CAP, older })
  if (sends === null) {
    return null
  }
  const held = keptSends(sends, operations, newest, null, anchorsOnly)
  return reachesBefore(held, earliest, newest) ? null : sends
}

/** Whether a send the window must hold sits before `first` (by its rows, or the head it was sent at). */
export function reachesBefore(sends: Send[], earliest: number | null, first: number): boolean {
  return (
    (earliest ?? Infinity) < first ||
    sends.some(
      (send) =>
        (send.submittedSequence ?? Infinity) < first || send.positions.some((at) => at < first)
    )
  )
}

/** Handed over and not answered: its turn is still to be attributed. */
export function unanswered(send: Send): boolean {
  return send.dispatchState === 'pending' || (send.dispatchState === 'unknown' && !send.recovered)
}

/** The sends the window holds: anchored, unanswered or placed in it, with every send sharing a
 *  provider id or queued card with one, since attribution reads the first or last of those. */
export function keptSends(
  sends: readonly Send[],
  operations: ReadonlySet<string>,
  start: number | null,
  end: number | null,
  anchorsOnly: boolean
): Send[] {
  const after = (position: number) =>
    start !== null && position >= start && (end === null || position < end)
  const kept = new Set(
    sends.filter(
      (send) =>
        operations.has(send.messageId) ||
        send.positions.some(after) ||
        (unanswered(send) && (!anchorsOnly || send.positions.every(after)))
    )
  )
  // Each family (sends sharing a provider id or queued card) is walked once, from its first held member.
  const families = new Map<string, Send[]>()
  const family = (send: Send) => [
    ...(send.providerItemId === null ? [] : [`p:${send.providerItemId}`]),
    ...(send.queuedMessageId === null ? [] : [`c:${send.queuedMessageId}`])
  ]
  for (const send of sends) {
    for (const key of family(send)) {
      const members = families.get(key)
      if (members) {
        members.push(send)
      } else {
        families.set(key, [send])
      }
    }
  }
  const frontier = [...kept]
  for (let send = frontier.pop(); send; send = frontier.pop()) {
    for (const key of family(send)) {
      for (const related of families.get(key) ?? []) {
        if (!kept.has(related)) {
          kept.add(related)
          frontier.push(related)
        }
      }
      families.delete(key)
    }
  }
  return sends.filter((send) => kept.has(send))
}
