export function scheduleInputFocus(focus: () => void, delayMs: number): () => void {
  let cancelled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (!cancelled) {
      timeout = setTimeout(() => {
        if (!cancelled) {
          focus()
        }
      }, delayMs)
    }
  }
  // WebKit has no idle callback; keep the same cancellable delay after its next frame.
  let cancel: () => void
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(schedule)
    cancel = () => cancelIdleCallback(id)
  } else {
    const id = requestAnimationFrame(schedule)
    cancel = () => cancelAnimationFrame(id)
  }
  return () => {
    cancelled = true
    cancel()
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}
