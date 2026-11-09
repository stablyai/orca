import { useCallback, type RefObject } from 'react'
import type { GestureResponderEvent, View } from 'react-native'

// Room around ✕ that still counts as dropping on it, matching the controls' touch box.
const DROP_SLOP = 12

type Box = { left: number; top: number; width: number; height: number }

function contains(box: Box, x: number, y: number): boolean {
  return (
    x >= box.left - DROP_SLOP &&
    x <= box.left + box.width + DROP_SLOP &&
    y >= box.top - DROP_SLOP &&
    y <= box.top + box.height + DROP_SLOP
  )
}

function hasClientRect(node: unknown): node is { getBoundingClientRect: () => DOMRect } {
  return (
    typeof node === 'object' &&
    node !== null &&
    'getBoundingClientRect' in node &&
    typeof node.getBoundingClientRect === 'function'
  )
}

// The page's ✕ is a DOM node: read it now, since RNW's measure skips its callback for a detached node and the release would be lost.
function pageBox(target: View): Box | null {
  if (!hasClientRect(target)) {
    return null
  }
  const rect = target.getBoundingClientRect()
  return {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  }
}

// Hold mode: letting go of the mic over ✕ cancels instead of inserting, like a voice note.
export function useMobileDictationCancelDrop(
  cancelRef: RefObject<View | null> | undefined,
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
      const settle = (box: Box) => (contains(box, pageX, pageY) ? onCancel() : onRelease?.())
      const box = pageBox(target)
      if (box) {
        settle(box)
        return
      }
      target.measure((_x, _y, width, height, left, top) => settle({ left, top, width, height }))
    },
    [cancelRef, onCancel, onRelease]
  )
}
