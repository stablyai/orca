/** Use the partition’s Electron Session as the shared lock key. */
export type CookieMutationLockOwner = WeakKey

const mutationLocks = new WeakMap<CookieMutationLockOwner, Promise<void>>()

/** Hold across clear, writes, and rollback so a stale rollback cannot undo a later import. */
export async function acquireCookieMutationLock(
  owner: CookieMutationLockOwner
): Promise<() => void> {
  const previous = mutationLocks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationLocks.set(
    owner,
    previous.then(() => current)
  )
  await previous
  return release
}

export async function withCookieMutationLock<T>(
  owner: CookieMutationLockOwner,
  run: () => Promise<T>
): Promise<T> {
  const release = await acquireCookieMutationLock(owner)
  try {
    return await run()
  } finally {
    release()
  }
}
