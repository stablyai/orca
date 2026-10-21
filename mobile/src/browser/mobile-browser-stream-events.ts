import type { Dispatch, SetStateAction } from 'react'
import { displayBrowserUrl } from './browser-url'
import { shouldSurfaceBrowserError } from './mobile-browser-frame-state'

/**
 * `error` is set when an answer did not reach the page, which leaves the page still blocked, and
 * `pending` is the token of the answer in flight — the card's buttons are dead while one is.
 */
export type BrowserDialogState = {
  dialogType: string
  message: string
  error?: string
  pending?: number
}

export type ScreencastEvent = {
  type?: string
  message?: string
  error?: { message?: string }
  dialogType?: string
  tab?: { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean }
}

type HandleScreencastEventArgs = {
  busyRef: { current: boolean }
  clearStartupTimer: () => void
  event: ScreencastEvent
  lastZoomResetUrlRef: { current: string }
  resetBrowserZoomState: () => void
  setAddressValue: Dispatch<SetStateAction<string>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
  setError: Dispatch<SetStateAction<string | null>>
}

export function handleBrowserScreencastEvent(args: HandleScreencastEventArgs): void {
  const {
    busyRef,
    clearStartupTimer,
    event,
    lastZoomResetUrlRef,
    resetBrowserZoomState,
    setAddressValue,
    setBusy,
    setDialog,
    setError
  } = args

  if (event.type === 'ready') {
    clearStartupTimer()
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
    if (typeof event.tab?.url === 'string') {
      setAddressValue(displayBrowserUrl(event.tab.url))
      if (event.tab.url !== lastZoomResetUrlRef.current) {
        lastZoomResetUrlRef.current = event.tab.url
        resetBrowserZoomState()
      }
    }
  } else if (event.type === 'end') {
    clearStartupTimer()
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
  } else if (event.type === 'dialog') {
    setDialog({
      dialogType: event.dialogType ?? 'alert',
      message: event.message ?? 'Browser dialog'
    })
  } else if (event.type === 'dialogClosed') {
    setDialog(null)
  } else if (event.type === 'error') {
    clearStartupTimer()
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
    const message = event.message ?? event.error?.message ?? 'Browser stream failed.'
    if (shouldSurfaceBrowserError(message)) {
      setError(message)
    }
  }
}
