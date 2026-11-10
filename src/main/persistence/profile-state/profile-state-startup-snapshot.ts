export function createProfileStateStartupSnapshotReader(
  value: Record<string, unknown> | undefined,
  assertActive: () => void,
  accept: () => void
): () => Record<string, unknown> | undefined {
  let pending: { value: Record<string, unknown> | undefined } | undefined = { value }
  return () => {
    assertActive()
    const snapshot = pending
    if (snapshot === undefined) {
      throw new Error('Profile state startup snapshot has already been consumed')
    }
    pending = undefined
    accept()
    return snapshot.value
  }
}
