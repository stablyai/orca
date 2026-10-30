import { systemPreferences } from 'electron'
import {
  BROWSER_HISTORY_GESTURE_CHANNEL,
  BROWSER_HISTORY_WHEEL_CHANNEL,
  BrowserHistoryGesture,
  type BrowserHistoryWheel
} from '../../shared/browser-history-gesture'
import { isAgentInjectingInput } from './agent-input-injection'
import type { ResolveRenderer } from './browser-guest-renderer-target'

function readWheel(value: unknown): BrowserHistoryWheel | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('gestureId' in value) ||
    !Number.isSafeInteger(value.gestureId) ||
    typeof value.gestureId !== 'number' ||
    !('deltaX' in value) ||
    typeof value.deltaX !== 'number' ||
    !Number.isFinite(value.deltaX) ||
    !('deltaY' in value) ||
    typeof value.deltaY !== 'number' ||
    !Number.isFinite(value.deltaY) ||
    !('blocked' in value) ||
    typeof value.blocked !== 'boolean'
  ) {
    return null
  }
  return {
    gestureId: value.gestureId,
    deltaX: value.deltaX,
    deltaY: value.deltaY,
    blocked: value.blocked
  }
}

export function setupGuestHistoryGesture({
  browserTabId,
  guest,
  resolveRenderer,
  isViewportPresetActive
}: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  isViewportPresetActive: () => boolean
}): () => void {
  if (process.platform !== 'darwin') {
    return () => {}
  }
  const gesture = new BrowserHistoryGesture()
  let armed = false
  const end = (): void => {
    const wasArmed = armed
    armed = false
    gesture.end()
    if (wasArmed && !guest.isDestroyed()) {
      guest.send(BROWSER_HISTORY_GESTURE_CHANNEL, null)
    }
  }
  const onInput = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (input.type === 'gestureScrollBegin') {
      if (
        !isAgentInjectingInput(guest) &&
        !isViewportPresetActive() &&
        systemPreferences.isSwipeTrackingFromScrollEventsEnabled()
      ) {
        armed = true
        guest.send(BROWSER_HISTORY_GESTURE_CHANNEL, gesture.begin())
      } else {
        end()
      }
    } else if (input.type === 'gestureScrollEnd' || input.type === 'gestureFlingStart') {
      end()
    }
  }
  const onWheel = (event: Electron.IpcMainEvent, channel: string, ...args: unknown[]): void => {
    if (channel !== BROWSER_HISTORY_WHEEL_CHANNEL) {
      return
    }
    if (event.senderFrame !== guest.mainFrame || isAgentInjectingInput(guest)) {
      return
    }
    const wheel = readWheel(args[0])
    if (!wheel) {
      return
    }
    if (isViewportPresetActive()) {
      end()
      return
    }
    const direction = gesture.record(wheel)
    if (!direction) {
      if (!gesture.isTracking) {
        end()
      }
      return
    }
    end()
    const canNavigate =
      direction === 'back'
        ? guest.navigationHistory.canGoBack()
        : guest.navigationHistory.canGoForward()
    if (canNavigate) {
      resolveRenderer(browserTabId)?.send('ui:browserHistoryNavigate', {
        browserPageId: browserTabId,
        direction
      })
    }
  }
  guest.on('input-event', onInput)
  guest.on('blur', end)
  guest.on('ipc-message', onWheel)
  return () => {
    end()
    guest.off('input-event', onInput)
    guest.off('blur', end)
    guest.off('ipc-message', onWheel)
  }
}
