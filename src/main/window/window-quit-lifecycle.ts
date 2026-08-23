type WindowQuitLifecycleOptions = {
  fenceTransfers: () => Promise<void>
  freezeSessions: () => void
  resumeTransfers: () => void
  resumeSessions: () => void
}

export function createWindowQuitLifecycle(options: WindowQuitLifecycleOptions): {
  begin: () => Promise<void>
  abort: () => void
  isActive: () => boolean
} {
  let pending: Promise<void> | null = null
  return {
    begin: () => {
      if (!pending) {
        pending = options.fenceTransfers()
        options.freezeSessions()
      }
      return pending
    },
    abort: () => {
      if (!pending) {
        return
      }
      pending = null
      options.resumeTransfers()
      options.resumeSessions()
    },
    isActive: () => pending !== null
  }
}
