import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import { RpcRefusedError } from '../../transport/rpc/rpc-refused-error'
import type { BrowserScreencastFrameMetadata } from '../screencast/browser-screencast-protocol'
import {
  browserDialogAccept,
  browserDialogDismiss,
  browserInsertText,
  browserKeypress,
  browserPointerClick,
  browserPointerDown,
  browserPointerMove,
  browserPointerUp
} from './mobile-browser-command-operations'
import type { BrowserPageCommandSend, BrowserPageParams } from './use-mobile-browser-request'
import {
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint,
  type BrowserPoint,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { BrowserDialogState } from '../screencast/mobile-browser-stream-events'
import { useMobileBrowserWheelQueue } from './use-mobile-browser-wheel-queue'
import { useMobileBrowserPageInputQueue } from './use-mobile-browser-page-input-queue'

const TOUCH_CLICK_RADIUS_DIP = 14
type SendBrowserRequest = (
  send: BrowserPageCommandSend,
  options?: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number }
) => Promise<unknown | null>

type MobileBrowserCommandArgs = {
  client: RpcClient | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  layoutRef: { current: BrowserTouchLayout | null }
  onToast: (message: string, durationMs?: number) => void
  pageParams: () => BrowserPageParams | null
  sendBrowserRequest: SendBrowserRequest
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserCommands(args: MobileBrowserCommandArgs) {
  const {
    client,
    frameMetadataRef,
    layoutRef,
    onToast,
    pageParams,
    sendBrowserRequest,
    setDialog,
    setError,
    zoomRef
  } = args

  const dialogAnswerTokenRef = useRef(0)
  const { commandGenerationRef, commandsMountedRef, sendWheel } = useMobileBrowserWheelQueue({
    client,
    frameMetadataRef,
    layoutRef,
    pageParams,
    setError,
    zoomRef
  })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clickPage = useCallback(
    async (point: BrowserPoint, button: 'left' | 'right') => {
      const base = pageParams()
      if (!commandsMountedRef.current || !client || !base) {
        return
      }
      const generation = commandGenerationRef.current
      try {
        browserPointerClick.interpret(
          await browserPointerClick.request(
            client,
            {
              ...base,
              x: point.x,
              y: point.y,
              button,
              // This phone shows a tap's picker refusal instead of replaying the tap; old hosts strip it.
              fileChooserRefusal: 1,
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
            { timeoutMs: 5_000 }
          )
        )
        if (generation === commandGenerationRef.current) {
          setError(null)
        }
        return
      } catch (error) {
        // The click landed and opened a file picker the host closed; replaying would open it again.
        if (isFileChooserRefusal(error)) {
          onToast(error.message, 3000)
          return
        }
        // Why: a timed-out click may still run on the host.
        if (generation !== commandGenerationRef.current || isRpcDeliveryUnknown(error)) {
          return
        }
      }
      try {
        const moveReply = await browserPointerMove.request(client, {
          ...base,
          x: point.x,
          y: point.y
        })
        browserPointerMove.interpret(moveReply)
        if (generation !== commandGenerationRef.current) {
          return
        }
        const downReply = await browserPointerDown.request(client, { ...base, button })
        browserPointerDown.interpret(downReply)
        // Release an admitted press even when its pane retired while mouseDown was pending.
        const upReply = await browserPointerUp.request(client, { ...base, button })
        browserPointerUp.interpret(upReply)
        if (generation === commandGenerationRef.current) {
          setError(null)
        }
      } catch (error) {
        if (isFileChooserRefusal(error)) {
          onToast(error.message, 3000)
        }
        // Other pointer failures race navigation; keep stream and surface actionable failures through navigation/stream paths.
      }
    },
    [client, onToast, pageParams]
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

  // Typing is live, so a failure says so once and the caller stops typing out of place.
  const reportTypingFailure = useCallback(
    (unconfirmed: boolean) => {
      if (!mountedRef.current) {
        return
      }
      onToast(
        unconfirmed
          ? translate(
              'browser.useBrowserCommands.deliveryUnconfirmed',
              'Delivery unconfirmed — check page before retrying'
            )
          : translate('browser.useBrowserCommands.typingFailed', "Typing didn't reach the page")
      )
    },
    [onToast]
  )

  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      let unconfirmed = false
      const result = await sendBrowserRequest(
        async (rpc, page, options) => {
          try {
            browserInsertText.interpret(
              await browserInsertText.request(rpc, { ...page, text }, options)
            )
            return true
          } catch (error) {
            unconfirmed = isRpcDeliveryUnknown(error)
            throw error
          }
        },
        { suppressError: true }
      )
      if (result === null) {
        reportTypingFailure(unconfirmed)
        return false
      }
      return true
    },
    [reportTypingFailure, sendBrowserRequest]
  )

  const sendKeypress = useCallback(
    async (key: string): Promise<boolean> => {
      let unconfirmed = false
      let toasted = false
      const result = await sendBrowserRequest(
        async (rpc, page, options) => {
          try {
            browserKeypress.interpret(await browserKeypress.request(rpc, { ...page, key }, options))
            return true
          } catch (error) {
            if (isFileChooserRefusal(error)) {
              toasted = true
              onToast(error.message, 3000)
            }
            unconfirmed = isRpcDeliveryUnknown(error)
            throw error
          }
        },
        { suppressError: true }
      )
      if (result === null) {
        if (!toasted) {
          reportTypingFailure(unconfirmed)
        }
        return false
      }
      return true
    },
    [onToast, reportTypingFailure, sendBrowserRequest]
  )

  const pageInput = useMobileBrowserPageInputQueue({ sendText, sendKeypress, mountedRef })

  const sendPointerClick = useCallback(
    (point: BrowserPoint, button: 'left' | 'right') =>
      pageInput.queue([{ run: () => clickPage(point, button) }]),
    [clickPage, pageInput]
  )

  // Card represents page’s actual block; only host dialogClosed proves answer applied, not button press.
  const sendDialogCommand = useCallback(
    async (method: 'browser.dialogAccept' | 'browser.dialogDismiss', promptText?: string) => {
      // Token binds answer to current dialog and disables duplicate taps; stale replies cannot mutate next card.
      const token = (dialogAnswerTokenRef.current += 1)
      setDialog((current) =>
        current === null ? null : { ...current, error: undefined, pending: token }
      )
      const result = await sendBrowserRequest(
        async (rpc, page, options) =>
          method === 'browser.dialogAccept'
            ? browserDialogAccept.interpret(
                await browserDialogAccept.request(
                  rpc,
                  promptText === undefined ? page : { ...page, text: promptText },
                  options
                )
              )
            : browserDialogDismiss.interpret(
                await browserDialogDismiss.request(rpc, page, options)
              ),
        { suppressError: true, timeoutMs: 5_000 }
      )
      const error = translate(
        'browser.useBrowserCommands.dialogAnswerFailed',
        'That answer did not reach the page.'
      )
      // Refusal/timeout leaves page blocked, so retain card with error explanation.
      setDialog((current) =>
        current === null || current.pending !== token
          ? current
          : {
              ...current,
              pending: undefined,
              ...(result === null ? { error } : {})
            }
      )
    },
    [sendBrowserRequest]
  )
  return {
    mapTouchPoint,
    pageInput,
    sendDialogCommand,
    sendPointerClick,
    sendWheel
  }
}

/** The host's sentence for a file picker it refused to open from a remote view. */
function isFileChooserRefusal(error: unknown): error is RpcRefusedError {
  return error instanceof RpcRefusedError && error.code === 'browser_file_chooser_opened'
}
