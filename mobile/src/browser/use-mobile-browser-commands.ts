import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import { assertRpcOk } from './mobile-browser-frame-state'
import {
  computeBrowserFrameGeometry,
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint,
  type BrowserPoint,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { BrowserPointerModifier } from './MobileBrowserPointerModifiers'

const TOUCH_CLICK_RADIUS_DIP = 14
type BrowserPageParams = { worktree: string; page: string }
type PendingWheelCommand = {
  base: BrowserPageParams
  point: BrowserPoint
  gestureId: number
  dx: number
  dy: number
}
type SendBrowserRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number }
) => Promise<unknown | null>

type MobileBrowserCommandArgs = {
  client: RpcClient | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  keyboardValue: string
  layoutRef: { current: BrowserTouchLayout | null }
  onToast: (message: string, durationMs?: number) => void
  pageParams: () => BrowserPageParams | null
  pointerModifiers: BrowserPointerModifier[]
  sendBrowserRequest: SendBrowserRequest
  setDialog: Dispatch<SetStateAction<{ dialogType: string; message: string } | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setKeyboardValue: Dispatch<SetStateAction<string>>
  setPointerModifiers: Dispatch<SetStateAction<BrowserPointerModifier[]>>
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserCommands(args: MobileBrowserCommandArgs) {
  const {
    client,
    frameMetadataRef,
    keyboardValue,
    layoutRef,
    onToast,
    pageParams,
    pointerModifiers,
    sendBrowserRequest,
    setDialog,
    setError,
    setKeyboardValue,
    setPointerModifiers,
    zoomRef
  } = args

  const pendingWheelCommandRef = useRef<PendingWheelCommand | null>(null)

  const wheelCommandInFlightRef = useRef(false)

  const flushPendingWheelCommand = useCallback(() => {
    if (wheelCommandInFlightRef.current) {
      return
    }
    const pending = pendingWheelCommandRef.current
    if (!pending || !client) {
      return
    }
    pendingWheelCommandRef.current = null
    wheelCommandInFlightRef.current = true
    void (async () => {
      try {
        assertRpcOk(
          await client.sendRequest('browser.mouseMove', {
            ...pending.base,
            x: pending.point.x,
            y: pending.point.y
          }),
          'Browser pointer move failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseWheel', {
            ...pending.base,
            dx: pending.dx,
            dy: pending.dy
          }),
          'Browser scroll failed'
        )
        setError(null)
      } catch {
        // Scroll bursts commonly race page reload/navigation. Avoid replacing
        // the live browser with transient command errors like selector_not_found.
      } finally {
        wheelCommandInFlightRef.current = false
        flushPendingWheelCommand()
      }
    })()
  }, [client])

  const sendPointerClick = useCallback(
    async (point: BrowserPoint, button: 'left' | 'right') => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      const clickResult = await sendBrowserRequest(
        'browser.mouseClick',
        {
          x: point.x,
          y: point.y,
          button,
          modifiers: pointerModifiers,
          ...(button === 'left'
            ? {
                radius: computeBrowserTouchClickRadiusCss(
                  layoutRef.current,
                  frameMetadataRef.current,
                  zoomRef.current,
                  TOUCH_CLICK_RADIUS_DIP
                )
              }
            : {})
        },
        { suppressError: true, timeoutMs: 5_000 }
      )
      if (clickResult !== null || pointerModifiers.length > 0) {
        return
      }
      try {
        assertRpcOk(
          await client.sendRequest('browser.mouseMove', { ...base, x: point.x, y: point.y }),
          'Browser pointer move failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseDown', { ...base, button }),
          'Browser pointer down failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseUp', { ...base, button }),
          'Browser pointer up failed'
        )
        setError(null)
      } catch {
        // Pointer commands can race page navigation. Keep the stream visible;
        // actionable failures still surface through navigation/stream errors.
      }
    },
    [client, pageParams, pointerModifiers, sendBrowserRequest]
  )

  const togglePointerModifier = useCallback((modifier: BrowserPointerModifier) => {
    setPointerModifiers((current) =>
      current.includes(modifier)
        ? current.filter((candidate) => candidate !== modifier)
        : [...current, modifier]
    )
  }, [])

  const sendWheel = useCallback(
    (point: BrowserPoint, screenDx: number, screenDy: number, gestureId: number) => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      const currentLayout = layoutRef.current
      const geometry = computeBrowserFrameGeometry(currentLayout, frameMetadataRef.current)
      const localZoom = zoomRef.current.scale
      const scale = (geometry?.scale ?? 1) * localZoom
      const cssDx = screenDx / scale
      const cssDy = screenDy / scale
      const delta = { dx: Math.round(-cssDx), dy: Math.round(-cssDy) }
      if (Math.abs(delta.dx) < 1 && Math.abs(delta.dy) < 1) {
        return
      }
      const pending = pendingWheelCommandRef.current
      pendingWheelCommandRef.current =
        pending && pending.base.page === base.page && pending.gestureId === gestureId
          ? {
              base,
              point,
              gestureId,
              dx: pending.dx + delta.dx,
              dy: pending.dy + delta.dy
            }
          : { base, point, gestureId, ...delta }
      flushPendingWheelCommand()
    },
    [client, flushPendingWheelCommand, pageParams]
  )

  const mapTouchPoint = useCallback((locationX: number, locationY: number): BrowserPoint | null => {
    return mapScreenToBrowserPoint(
      locationX,
      locationY,
      layoutRef.current,
      frameMetadataRef.current,
      zoomRef.current
    )
  }, [])

  const sendKeyboardText = useCallback(async () => {
    const text = keyboardValue
    if (!text) {
      return
    }
    setKeyboardValue('')
    const result = await sendBrowserRequest(
      'browser.keyboardInsertText',
      { text },
      { suppressError: true }
    )
    if (result !== null) {
      onToast('Sent')
    } else {
      setKeyboardValue(text)
    }
  }, [keyboardValue, onToast, sendBrowserRequest])

  const sendKeypress = useCallback(
    async (key: string) => {
      await sendBrowserRequest('browser.keypress', { key }, { suppressError: true })
    },
    [sendBrowserRequest]
  )

  const sendDialogCommand = useCallback(
    async (method: 'browser.dialogAccept' | 'browser.dialogDismiss') => {
      setDialog(null)
      await sendBrowserRequest(method, {}, { suppressError: true, timeoutMs: 5_000 })
    },
    [sendBrowserRequest]
  )
  return {
    mapTouchPoint,
    sendDialogCommand,
    sendKeyboardText,
    sendKeypress,
    sendPointerClick,
    sendWheel,
    togglePointerModifier
  }
}
