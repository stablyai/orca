export const SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS = 30_000

export function createSshFileStreamInactivityDeadline(onTimeout: () => void): {
  reset: () => void
  clear: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    reset: () => {
      clear()
      timer = setTimeout(onTimeout, SSH_FILE_STREAM_INACTIVITY_TIMEOUT_MS)
      timer.unref?.()
    },
    clear
  }
}
