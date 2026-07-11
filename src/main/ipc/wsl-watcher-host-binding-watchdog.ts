export type WatcherBindingWatchdog = {
  watch<Result>(operation: string, pending: Promise<Result>): Promise<Result>
}

export function createWatcherBindingWatchdog(
  exit: (code: number) => void,
  timeoutMs: number
): WatcherBindingWatchdog {
  let recycling = false
  // Why: concurrent native timeouts must trigger only one host recycle.
  const recycleHost = (operation: string): void => {
    if (recycling) {
      return
    }
    recycling = true
    process.stderr.write(`[wsl-watcher-host] native ${operation} did not settle\n`)
    exit(4)
  }
  return {
    watch: async <Result>(operation: string, pending: Promise<Result>): Promise<Result> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          recycleHost(operation)
          reject(new Error(`Native watcher ${operation} timed out`))
        }, timeoutMs)
        timer.unref?.()
      })
      try {
        return await Promise.race([pending, timeout])
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
  }
}
