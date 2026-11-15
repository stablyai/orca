export async function selectBranchReview<T>(input: {
  readRecent: () => Promise<T[]>
  readActive: () => Promise<T | null>
  isActive: (review: T) => boolean
  pageSize: number
}): Promise<T | null> {
  const recent = await input.readRecent()
  const active = recent.find(input.isActive)
  if (active) {
    return active
  }
  // A full mixed-state page cannot prove that no older active review exists.
  return recent.length < input.pageSize
    ? (recent[0] ?? null)
    : ((await input.readActive()) ?? recent[0] ?? null)
}

export function shouldHideMergedImplicitReview(
  state: string,
  linkedNumber: number | null | undefined,
  reviewHead: string | null | undefined,
  currentHead: string | null
): boolean {
  return (
    typeof linkedNumber !== 'number' &&
    state.toLowerCase() === 'merged' &&
    (!currentHead || reviewHead !== currentHead)
  )
}
