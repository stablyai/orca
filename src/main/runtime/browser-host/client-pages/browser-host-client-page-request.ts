export function createBrowserHostClientPageRequest(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  const abort = (): void => controller.abort(new Error('browser_host_page_creation_cancelled'))
  const expire = (): void => controller.abort(new Error('browser_host_page_creation_timeout'))
  const timer = setTimeout(expire, timeoutMs)
  caller?.addEventListener('abort', abort, { once: true })
  if (caller?.aborted) {
    abort()
  }
  const current = (): void => {
    if (Date.now() >= deadline && !controller.signal.aborted) {
      expire()
    }
    controller.signal.throwIfAborted()
  }
  return {
    signal: controller.signal,
    cancel: abort,
    current,
    async wait<T>(result: Promise<T>): Promise<T> {
      let remove = (): void => {}
      const cancelled = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => reject(controller.signal.reason)
        if (controller.signal.aborted) {
          rejectAbort()
        } else {
          controller.signal.addEventListener('abort', rejectAbort, { once: true })
          remove = () => controller.signal.removeEventListener('abort', rejectAbort)
        }
      })
      try {
        return await Promise.race([result, cancelled])
      } finally {
        remove()
      }
    },
    dispose(): void {
      clearTimeout(timer)
      caller?.removeEventListener('abort', abort)
    }
  }
}
