import type { WebContents } from 'electron'

export function isAbortedNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { code, errno } = error as { code?: unknown; errno?: unknown }
  return code === 'ERR_ABORTED' || errno === -3
}

export function isWebContentsLoading(wc: WebContents): boolean {
  try {
    return wc.isLoading()
  } catch {
    // The caller rechecks authoritative page registration after waiting.
    return false
  }
}

export function isLoadingMainFrame(wc: WebContents): boolean {
  try {
    return wc.isLoadingMainFrame()
  } catch {
    return false
  }
}

// True until the main resource's first response arrives, which can precede commit; subframes never count.
export function isWaitingForMainFrameResponse(wc: WebContents): boolean {
  try {
    return wc.isWaitingForResponse()
  } catch {
    return false
  }
}

/** Settles when loading stops, or once a committed main document loads while subframes still load. */
export function waitForInFlightNavigation(
  wc: WebContents,
  timeoutMs: number
): Promise<'settled' | 'timed-out'> {
  if (!isWebContentsLoading(wc)) {
    return Promise.resolve('settled')
  }

  return new Promise((resolve) => {
    let settled = false
    let mainFrameCommitted = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: 'settled' | 'timed-out'): void => {
      if (settled) {
        return
      }
      settled = true
      wc.removeListener('did-stop-loading', onSettled)
      wc.removeListener('did-navigate', onDidNavigate)
      wc.removeListener('did-finish-load', onDidFinishLoad)
      wc.removeListener('destroyed', onSettled)
      if (timeout) {
        clearTimeout(timeout)
      }
      resolve(outcome)
    }
    const onSettled = (): void => finish('settled')
    const onDidNavigate = (): void => {
      mainFrameCommitted = true
    }
    // did-finish-load is main-frame only; the outgoing document's own load must not count.
    const onDidFinishLoad = (): void => {
      if (mainFrameCommitted) {
        finish('settled')
      }
    }

    wc.on('did-stop-loading', onSettled)
    wc.on('did-navigate', onDidNavigate)
    wc.on('did-finish-load', onDidFinishLoad)
    wc.on('destroyed', onSettled)
    timeout = setTimeout(() => finish('timed-out'), timeoutMs)
    timeout.unref?.()

    // Loading may finish between loadURL settling and listener attachment.
    if (!isWebContentsLoading(wc)) {
      finish('settled')
    }
  })
}

export const EMBEDDED_NAVIGATION_TIMEOUT_MS = 30_000
