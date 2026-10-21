const SESSION_PREFERENCE_READ_TIMEOUT_MS = 5000

export async function settleSessionPreferenceRead<T>(read: Promise<T>): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), SESSION_PREFERENCE_READ_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}
