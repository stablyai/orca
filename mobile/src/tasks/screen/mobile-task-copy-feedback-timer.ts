export type MobileTaskCopyFeedbackTimerRef = {
  current: ReturnType<typeof setTimeout> | null
}

type SetCopiedTaskKey = (updater: (current: string | null) => string | null) => void

export function clearMobileTaskCopyFeedbackTimer(timerRef: MobileTaskCopyFeedbackTimerRef): void {
  if (timerRef.current === null) {
    return
  }
  clearTimeout(timerRef.current)
  timerRef.current = null
}

export function scheduleMobileTaskCopyFeedbackReset(
  timerRef: MobileTaskCopyFeedbackTimerRef,
  key: string,
  setCopiedKey: SetCopiedTaskKey,
  delayMs = 1500
): void {
  // Replace the shared feedback timer so older copies cannot clear newer feedback or outlive unmount.
  clearMobileTaskCopyFeedbackTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    setCopiedKey((current) => (current === key ? null : current))
  }, delayMs)
}
