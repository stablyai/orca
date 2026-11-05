import { useEffect, useRef, useState } from 'react'
import { PanResponder } from 'react-native'
import {
  HOST_DOCK_DEFAULT_WIDTH,
  HOST_DOCK_MAX_WIDTH,
  HOST_DOCK_MIN_WIDTH,
  clampHostDockWidth,
  loadHostDockWidth,
  saveHostDockWidth
} from '../storage/preferences'
import { SESSION_DOCK_MIN_MAIN_WIDTH } from './session-panel-host'

type MobileDockResize = {
  dockWidth: number
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers']
}

function clampDockWidthForRow(width: number, availableWidth: number): number {
  const maxForRow =
    Number.isFinite(availableWidth) && availableWidth > 0
      ? Math.max(HOST_DOCK_MIN_WIDTH, availableWidth - SESSION_DOCK_MIN_MAIN_WIDTH)
      : HOST_DOCK_MAX_WIDTH
  return Math.min(Math.min(HOST_DOCK_MAX_WIDTH, maxForRow), clampHostDockWidth(width))
}

// Attach PanResponder to a leaf edge overlay: Android child scroll views consume container move events. Dragging left widens the right dock.
export function useMobileDockResize(availableWidth = 0): MobileDockResize {
  const [dockWidth, setDockWidth] = useState(HOST_DOCK_DEFAULT_WIDTH)

  const availableWidthRef = useRef(availableWidth)
  availableWidthRef.current = availableWidth
  const widthRef = useRef(dockWidth)
  widthRef.current = dockWidth
  const dragStartRef = useRef(dockWidth)

  useEffect(() => {
    let stale = false
    void loadHostDockWidth().then((saved) => {
      if (!stale) {
        setDockWidth(clampDockWidthForRow(saved, availableWidthRef.current))
      }
    })
    return () => {
      stale = true
    }
  }, [])

  useEffect(() => {
    setDockWidth((prev) => clampDockWidthForRow(prev, availableWidth))
  }, [availableWidth])

  const resizer = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragStartRef.current = widthRef.current
      },
      onPanResponderMove: (_evt, g) => {
        setDockWidth(clampDockWidthForRow(dragStartRef.current - g.dx, availableWidthRef.current))
      },
      onPanResponderRelease: () => {
        void saveHostDockWidth(widthRef.current)
      },
      onPanResponderTerminate: () => {
        void saveHostDockWidth(widthRef.current)
      }
    })
  ).current

  return { dockWidth, panHandlers: resizer.panHandlers }
}
