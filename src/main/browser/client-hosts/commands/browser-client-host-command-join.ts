export async function joinBrowserClientHostCommands(
  handlers: Promise<void>[],
  timeoutMs: number
): Promise<boolean> {
  if (handlers.length === 0) {
    return true
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(handlers).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
