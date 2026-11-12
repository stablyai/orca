import { useCallback, type RefObject } from 'react'
import type { GestureResponderEvent, HostInstance } from 'react-native'
import { measurePageBox, type PageBox } from '../platform/page-box'

// A dragging finger lands less precisely than a tap, so the drop zone reaches past ✕.
const DROP_SLOP = 12

function contains(box: PageBox, x: number, y: number): boolean {
  return (
    x >= box.left - DROP_SLOP &&
    x <= box.left + box.width + DROP_SLOP &&
    y >= box.top - DROP_SLOP &&
    y <= box.top + box.height + DROP_SLOP
  )
}

// Hold mode: letting go of the mic over ✕ cancels instead of inserting, like a voice note.
export function useMobileDictationCancelDrop(
  cancelRef: RefObject<HostInstance | null> | undefined,
  onCancel: (() => void) | undefined,
  onRelease: (() => void) | undefined
): (event: GestureResponderEvent) => void {
  return useCallback(
    (event: GestureResponderEvent) => {
      const target = cancelRef?.current
      const { pageX, pageY } = event.nativeEvent
      if (!target || !onCancel || typeof pageX !== 'number' || typeof pageY !== 'number') {
        onRelease?.()
        return
      }
      measurePageBox(target, (box) => {
        if (box && contains(box, pageX, pageY)) {
          onCancel()
        } else {
          onRelease?.()
        }
      })
    },
    [cancelRef, onCancel, onRelease]
  )
}
