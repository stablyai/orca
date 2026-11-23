/** Use the partition’s Electron Session as the shared lock key. */
export type CookieMutationLockOwner = WeakKey

const mutationLocks = new WeakMap<CookieMutationLockOwner, Promise<void>>()
const importSourceLocks = new WeakMap<CookieMutationLockOwner, Promise<void>>()

/** Hold across clear, writes, and rollback so a stale rollback cannot undo a later import. */
export async function acquireCookieMutationLock(
  owner: CookieMutationLockOwner
): Promise<() => void> {
  return acquireLock(mutationLocks, owner)
}

async function acquireLock(
  locks: WeakMap<CookieMutationLockOwner, Promise<void>>,
  owner: CookieMutationLockOwner
): Promise<() => void> {
  const previous = locks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(
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
  return withLock(mutationLocks, owner, run)
}

/** Admit source validation, import or clear, and provenance updates together. Cookie I/O takes the inner lock. */
export function withCookieImportSourceLock<T>(
  owner: CookieMutationLockOwner,
  run: () => Promise<T>
): Promise<T> {
  return withLock(importSourceLocks, owner, run)
}

async function withLock<T>(
  locks: WeakMap<CookieMutationLockOwner, Promise<void>>,
  owner: CookieMutationLockOwner,
  run: () => Promise<T>
): Promise<T> {
  const release = await acquireLock(locks, owner)
  try {
    return await run()
  } finally {
    release()
  }
}
