/**
 * Restoring the text of a send the host definitely rejected.
 *
 * Merge, never skip. The composer is cleared at send time, and a rejected send
 * never reaches `acceptSend`, so the rejected text has no other surviving copy —
 * declining to restore it because the user has since typed again loses the
 * message outright. Over relay/SSH that window is seconds, not milliseconds.
 *
 * Ordering is by authorship: the rejected text was composed before whatever was
 * typed after it, so it goes first and the newer text follows on its own line.
 */
export function mergeRejectedDraftInto(
  drafts: Record<string, string>,
  draftKey: string,
  rejected: string
): Record<string, string> {
  const current = drafts[draftKey] ?? ''
  // An identical composer already holds the text; appending would duplicate it.
  if (current === rejected) {
    return drafts
  }
  return { ...drafts, [draftKey]: current === '' ? rejected : `${rejected}\n${current}` }
}
