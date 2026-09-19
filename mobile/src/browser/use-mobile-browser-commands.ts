import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import {
  browserDialogAccept,
  browserDialogDismiss,
  browserInsertText,
  browserKeypress,
  browserPointerClick,
  browserPointerDown,
  browserPointerMove,
  browserPointerUp,
  browserPointerWheel
} from './mobile-browser-command-operations'
import type { BrowserPageCommandSend, BrowserPageParams } from './use-mobile-browser-request'
import {
  computeBrowserFrameGeometry,
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint,
  type BrowserPoint,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { BrowserPointerModifier } from './browser-keyboard-descriptors'

const TOUCH_CLICK_RADIUS_DIP = 14
type PendingWheelCommand = {
  base: BrowserPageParams
  point: BrowserPoint
  gestureId: number
  dx: number
  dy: number
}
type SendBrowserRequest = (
  send: BrowserPageCommandSend,
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
        const moveReply = await browserPointerMove.request(client, {
          ...pending.base,
          x: pending.point.x,
          y: pending.point.y
        })
        browserPointerMove.interpret(moveReply)
        const wheelReply = await browserPointerWheel.request(client, {
          ...pending.base,
          dx: pending.dx,
          dy: pending.dy
        })
        browserPointerWheel.interpret(wheelReply)
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
        async (rpc, page, options) =>
          browserPointerClick.interpret(
            await browserPointerClick.request(
              rpc,
              {
                ...page,
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
              options
            )
          ),
        { suppressError: true, timeoutMs: 5_000 }
      )
      if (clickResult !== null || pointerModifiers.length > 0) {
        return
      }
      try {
        const moveReply = await browserPointerMove.request(client, {
          ...base,
          x: point.x,
          y: point.y
        })
        browserPointerMove.interpret(moveReply)
        const downReply = await browserPointerDown.request(client, { ...base, button })
        browserPointerDown.interpret(downReply)
        const upReply = await browserPointerUp.request(client, { ...base, button })
        browserPointerUp.interpret(upReply)
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
      async (rpc, page, options) =>
        browserInsertText.interpret(
          await browserInsertText.request(rpc, { ...page, text }, options)
        ),
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
      await sendBrowserRequest(
        async (rpc, page, options) =>
          browserKeypress.interpret(await browserKeypress.request(rpc, { ...page, key }, options)),
        { suppressError: true }
      )
    },
    [sendBrowserRequest]
  )

  const sendDialogCommand = useCallback(
    async (method: 'browser.dialogAccept' | 'browser.dialogDismiss') => {
      setDialog(null)
      const command = method === 'browser.dialogAccept' ? browserDialogAccept : browserDialogDismiss
      await sendBrowserRequest(
        async (rpc, page, options) => command.interpret(await command.request(rpc, page, options)),
        { suppressError: true, timeoutMs: 5_000 }
      )
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
