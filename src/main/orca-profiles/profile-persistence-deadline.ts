import type { Store } from '../persistence'

const PROFILE_PERSISTENCE_TIMEOUT_MS = 20_000

export async function flushActiveProfileBeforeFileMutation(store: Store): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('orca_profile_persistence_timeout'))
    }, PROFILE_PERSISTENCE_TIMEOUT_MS)
  })
  try {
    await Promise.race([store.flushPendingOrThrowAsync({ signal: controller.signal }), deadline])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
