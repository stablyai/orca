import { statfs } from 'node:fs/promises'

const NEARLY_FULL_BELOW_BYTES = 100 * 1024 * 1024
const CHECK_TIMEOUT_MS = 2_000

/** Undefined when unknown: the check failed or a slow network folder did not answer in time. */
export async function isProfileStorageNearlyFull(
  directory: string,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  const checked = statfs(directory).then(
    (stats) => {
      const freeBytes = Number(stats.bavail) * Number(stats.bsize)
      return Number.isFinite(freeBytes) ? freeBytes < NEARLY_FULL_BELOW_BYTES : undefined
    },
    () => undefined
  )
  try {
    return await Promise.race([checked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
