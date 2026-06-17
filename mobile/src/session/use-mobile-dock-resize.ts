import { useEffect, useRef, useState } from 'react'
import { PanResponder } from 'react-native'
import {
  HOST_DOCK_DEFAULT_WIDTH,
  clampHostDockWidth,
  loadHostDockWidth,
  saveHostDockWidth
} from '../storage/preferences'

type MobileDockResize = {
  dockWidth: number
  // Spread onto the dock's dedicated left-edge handle (a leaf overlay), NOT the
  // dock container — see the note below.
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers']
}

// Owns the wide-layout right-dock width + its drag-to-resize gesture.
//
// Why a dedicated edge handle (mirrors the left sidebar): on Android a child
// ScrollView/FlatList claims the native touch responder, so a PanResponder on
// the dock container never sees the move events and the drag silently no-ops.
// A leaf handle overlaid on the dock's left border owns the gesture on both
// platforms. The dock grows leftward, so dragging left (negative dx) widens it.
export function useMobileDockResize(): MobileDockResize {
  const [dockWidth, setDockWidth] = useState(HOST_DOCK_DEFAULT_WIDTH)

  const widthRef = useRef(dockWidth)
  widthRef.current = dockWidth
  const dragStartRef = useRef(dockWidth)

  useEffect(() => {
    let stale = false
    void loadHostDockWidth().then((saved) => {
      if (!stale) {
        setDockWidth(saved)
      }
    })
    return () => {
      stale = true
    }
  }, [])

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
        setDockWidth(clampHostDockWidth(dragStartRef.current - g.dx))
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
