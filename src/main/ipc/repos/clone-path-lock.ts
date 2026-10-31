import { runWithGitReadCacheInvalidation } from '../../git/status'

const cloneInFlightByPath = new Map<string, Promise<void>>()

export async function runWithClonePathLock<T>(
  clonePathKey: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = cloneInFlightByPath.get(clonePathKey) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => current,
    () => current
  )
  cloneInFlightByPath.set(clonePathKey, tail)

  try {
    await previous
    return await runWithGitReadCacheInvalidation(task)
  } finally {
    release()
    if (cloneInFlightByPath.get(clonePathKey) === tail) {
      cloneInFlightByPath.delete(clonePathKey)
    }
  }
}
