// Keep optional member read at caller: resume enrichment tolerates refusal/null; moving read into operation would make null throw.
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
