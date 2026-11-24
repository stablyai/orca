import type { Dispatch, SetStateAction } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import { displayBrowserUrl } from '../pane-view/browser-url'
import { shouldSurfaceBrowserError } from './mobile-browser-frame-state'

// error leaves page blocked after failed answer; pending token disables buttons for sole in-flight answer.
let lastDialogOccurrence = 0

export type BrowserDialogState = {
  /** Identifies one opened dialog, so a typed answer never carries into the next. */
  occurrence: number
  dialogType: string
  message: string
  defaultPromptText: string
  /** The asking frame's origin; null on older hosts and pages without one. */
  origin: string | null
  error?: string
  pending?: number
}

export type ScreencastEvent = {
  type?: string
  message?: string
  error?: { message?: string }
  dialogType?: string
  defaultPromptText?: string
  origin?: string | null
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
  /** The host finished this stream, so no more frames come until the phone subscribes again. */
  setStreamStopped: Dispatch<SetStateAction<string | null>>
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
    setStreamStopped
  } = args

  if (event.type === 'ready') {
    clearStartupTimer()
    // A stream that answers after the startup timeout is live after all.
    setStreamStopped(null)
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
    // An error frame before the end already said why.
    setStreamStopped((current) => current ?? translate('browser.stream.stopped', 'Stream stopped'))
  } else if (event.type === 'dialog') {
    const dialogType = event.dialogType ?? 'alert'
    const message = event.message ?? 'Browser dialog'
    const nextOccurrence = (lastDialogOccurrence += 1)
    setDialog((current) => ({
      dialogType,
      message,
      defaultPromptText: event.defaultPromptText ?? '',
      origin: event.origin ?? null,
      // The host re-sends the dialog it still holds; only one opened after a close is a new occurrence.
      occurrence:
        current?.dialogType === dialogType && current.message === message
          ? current.occurrence
          : nextOccurrence
    }))
  } else if (event.type === 'dialogClosed') {
    setDialog(null)
  } else if (event.type === 'error') {
    clearStartupTimer()
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
    const message = event.message ?? event.error?.message ?? 'Browser stream failed.'
    // The host stops the stream after an error frame, so it offers Reconnect like an end.
    if (shouldSurfaceBrowserError(message)) {
      setStreamStopped(message)
    }
  }
}

export function readScreencastReady(
  payload: unknown
): { subscriptionId: string; frameAck: unknown } | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('type' in payload) ||
    payload.type !== 'ready' ||
    !('subscriptionId' in payload) ||
    typeof payload.subscriptionId !== 'string'
  ) {
    return null
  }
  return {
    subscriptionId: payload.subscriptionId,
    frameAck: 'frameAck' in payload ? payload.frameAck : undefined
  }
}
