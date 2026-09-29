/**
 * One list off an enrichment read in the resume sheet's metadata load.
 *
 * Optional-chained on purpose: main tolerated both a refusal and a null result here, so folding
 * the member read into the operation's own reader would have started throwing on the latter.
 */
export function readAcceptedResumeList<T>(
  accepted: { accepted: false } | { accepted: true; value: unknown } | null,
  key: string
): T[] | undefined {
  if (!accepted?.accepted) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return (accepted.value as Record<string, T[] | undefined> | null | undefined)?.[key]
}
