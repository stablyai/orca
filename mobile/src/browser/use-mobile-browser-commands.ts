import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
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
import type { BrowserPointerModifier } from './MobileBrowserPointerModifiers'
import type { BrowserDialogState } from './mobile-browser-stream-events'
import { useMobileBrowserWheelQueue } from './use-mobile-browser-wheel-queue'

const TOUCH_CLICK_RADIUS_DIP = 14
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
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
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

  const dialogAnswerTokenRef = useRef(0)
  const { commandGenerationRef, commandsMountedRef, sendWheel } = useMobileBrowserWheelQueue({
    client,
    frameMetadataRef,
    layoutRef,
    pageParams,
    setError,
    zoomRef
  })
  // A send claims the draft here, so a repeat tap before re-render finds it empty. The pane remounts
  // per page, so the draft outlives a reconnect; only unmount ends a send's claim on it.
  const keyboardDraftRef = useRef({ mounted: true, value: keyboardValue })
  useLayoutEffect(() => {
    keyboardDraftRef.current.value = keyboardValue
  }, [keyboardValue])
  useEffect(() => {
    const draft = keyboardDraftRef.current
    draft.mounted = true
    return () => {
      draft.mounted = false
    }
  }, [])

  const sendPointerClick = useCallback(
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
            { timeoutMs: 5_000 }
          )
        )
        if (generation === commandGenerationRef.current) {
          setError(null)
        }
        return
      } catch (error) {
        // Why: a timed-out click may still run on the host, and the move/down/up replay drops modifiers.
        if (
          generation !== commandGenerationRef.current ||
          isRpcDeliveryUnknown(error) ||
          pointerModifiers.length > 0
        ) {
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
      } catch {
        // Pointer sends race navigation; keep stream and surface actionable failures through navigation/stream paths.
      }
    },
    [client, pageParams, pointerModifiers]
  )

  const togglePointerModifier = useCallback((modifier: BrowserPointerModifier) => {
    setPointerModifiers((current) =>
      current.includes(modifier)
        ? current.filter((candidate) => candidate !== modifier)
        : [...current, modifier]
    )
  }, [])

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
    const draft = keyboardDraftRef.current
    const text = draft.value
    if (!text) {
      return
    }
    draft.value = ''
    setKeyboardValue('')
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
    if (!draft.mounted) {
      return
    }
    if (result !== null) {
      onToast(translate('browser.useBrowserCommands.sent', 'Sent'))
      return
    }
    setKeyboardValue((current) => text + current)
    if (unconfirmed) {
      const warning = translate(
        'browser.useBrowserCommands.deliveryUnconfirmed',
        'Delivery unconfirmed — check page before retrying'
      )
      onToast(warning)
    }
  }, [onToast, sendBrowserRequest])

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

  // Card represents page’s actual block; only host dialogClosed proves answer applied, not button press.
  const sendDialogCommand = useCallback(
    async (method: 'browser.dialogAccept' | 'browser.dialogDismiss') => {
      const command = method === 'browser.dialogAccept' ? browserDialogAccept : browserDialogDismiss
      // Token binds answer to current dialog and disables duplicate taps; stale replies cannot mutate next card.
      const token = (dialogAnswerTokenRef.current += 1)
      setDialog((current) =>
        current === null ? null : { ...current, error: undefined, pending: token }
      )
      const result = await sendBrowserRequest(
        async (rpc, page, options) => command.interpret(await command.request(rpc, page, options)),
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
    sendDialogCommand,
    sendKeyboardText,
    sendKeypress,
    sendPointerClick,
    sendWheel,
    togglePointerModifier
  }
}
