import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import { browserPointerMove, browserPointerWheel } from './mobile-browser-command-operations'
import type { BrowserPageParams } from './use-mobile-browser-request'
import {
  browserWheelDeltaFromScreen,
  computeBrowserFrameGeometry,
  type BrowserPoint,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'

type PendingWheelCommand = {
  base: BrowserPageParams
  point: BrowserPoint
  gestureId: number
  dx: number
  dy: number
}

type BrowserWheelQueueArgs = {
  client: RpcClient | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  layoutRef: { current: BrowserTouchLayout | null }
  pageParams: () => BrowserPageParams | null
  setError: Dispatch<SetStateAction<string | null>>
  zoomRef: { current: BrowserZoomState }
}

// Retires queued wheel work with its pane/client so departed owners cannot drain into a live one.
export function useMobileBrowserWheelQueue(args: BrowserWheelQueueArgs) {
  const { client, frameMetadataRef, layoutRef, pageParams, setError, zoomRef } = args
  const pendingWheelCommandRef = useRef<PendingWheelCommand | null>(null)
  const wheelCommandInFlightRef = useRef(false)
  const commandGenerationRef = useRef(0)
  const commandsMountedRef = useRef(false)

  useLayoutEffect(() => {
    commandsMountedRef.current = true
    return () => {
      commandsMountedRef.current = false
      commandGenerationRef.current += 1
      pendingWheelCommandRef.current = null
      wheelCommandInFlightRef.current = false
    }
  }, [client, pageParams])

  const flushPendingWheelCommand = useCallback(() => {
    if (!commandsMountedRef.current || wheelCommandInFlightRef.current) {
      return
    }
    const pending = pendingWheelCommandRef.current
    if (!pending || !client) {
      return
    }
    pendingWheelCommandRef.current = null
    wheelCommandInFlightRef.current = true
    const generation = commandGenerationRef.current
    void (async () => {
      try {
        const moveReply = await browserPointerMove.request(client, {
          ...pending.base,
          x: pending.point.x,
          y: pending.point.y
        })
        browserPointerMove.interpret(moveReply)
        if (generation !== commandGenerationRef.current) {
          return
        }
        const wheelReply = await browserPointerWheel.request(client, {
          ...pending.base,
          dx: pending.dx,
          dy: pending.dy
        })
        browserPointerWheel.interpret(wheelReply)
        if (generation === commandGenerationRef.current) {
          setError(null)
        }
      } catch {
        // Scroll bursts race navigation; keep usable stream instead of replacing it with transient selector errors.
      } finally {
        if (generation === commandGenerationRef.current) {
          wheelCommandInFlightRef.current = false
          flushPendingWheelCommand()
        }
      }
    })()
  }, [client])

  const sendWheel = useCallback(
    (point: BrowserPoint, screenDx: number, screenDy: number, gestureId: number) => {
      const base = pageParams()
      if (!commandsMountedRef.current || !client || !base) {
        return
      }
      const geometry = computeBrowserFrameGeometry(layoutRef.current, frameMetadataRef.current)
      const delta = browserWheelDeltaFromScreen(screenDx, screenDy, geometry, zoomRef.current.scale)
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

  return { commandGenerationRef, commandsMountedRef, sendWheel }
}
