import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { View } from 'react-native'
import { useKeyboardOcclusion } from '../../../platform/keyboard-occlusion'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard-persisting-taps'

type Placement = {
  root: HTMLElement
  left: number
  bottom: number
  width: number
  maxHeight: number
}

export function MobileNativeChatComposerMenuLayer({
  anchorRef,
  children
}: {
  anchorRef: RefObject<View | null>
  children: ReactNode
}) {
  const keyboard = useKeyboardOcclusion()
  const keepKeyboard = useKeyboardPersistingTaps('always')
  const surfaceRef = useRef<HTMLElement | null>(null)
  const updateRef = useRef<(() => void) | null>(null)
  const setSurface = useCallback(
    (node: unknown) => {
      surfaceRef.current = node instanceof HTMLElement ? node : null
      keepKeyboard(node)
    },
    [keepKeyboard]
  )
  const [placement, setPlacement] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    const anchor: unknown = anchorRef.current
    if (!(anchor instanceof HTMLElement)) {
      return
    }
    // Stay in the chat's stacking ancestry while escaping the queue's scrolling clip.
    const root = anchor.closest<HTMLElement>('[data-testid="native-chat-view"]')
    if (!root) {
      return
    }
    const ownerDocument = anchor.ownerDocument
    let disposed = false
    const update = (focusTarget: EventTarget | null = ownerDocument.activeElement) => {
      if (
        !(focusTarget instanceof Node) ||
        (!anchor.contains(focusTarget) && !surfaceRef.current?.contains(focusTarget))
      ) {
        setPlacement(null)
        return
      }
      const rect = anchor.getBoundingClientRect()
      const bounds = root.getBoundingClientRect()
      const viewport = window.visualViewport
      const top = Math.max(bounds.top, viewport?.offsetTop ?? 0)
      let visibleTop = top
      let visibleBottom = Math.min(
        bounds.bottom,
        window.innerHeight - keyboard,
        viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      )
      for (
        let parent = anchor.parentElement;
        parent && parent !== root;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) {
          const clip = parent.getBoundingClientRect()
          visibleTop = Math.max(visibleTop, clip.top)
          visibleBottom = Math.min(visibleBottom, clip.bottom)
        }
      }
      if (
        !anchor.isConnected ||
        visibleBottom <= visibleTop ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= visibleTop ||
        rect.top >= visibleBottom
      ) {
        setPlacement(null)
        return
      }
      const menuBottom = Math.max(rect.top, visibleTop)
      const next = {
        root,
        left: rect.left - bounds.left,
        bottom: bounds.bottom - menuBottom,
        width: rect.width,
        maxHeight: Math.max(0, menuBottom - top)
      }
      setPlacement((current) =>
        current?.root === next.root &&
        current.left === next.left &&
        current.bottom === next.bottom &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next
      )
    }
    const updateGeometry = () => update()
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget) {
        update(event.relatedTarget)
      } else {
        // Finish the focus transfer before deciding whether the interaction lost focus.
        queueMicrotask(() => {
          if (!disposed) {
            update()
          }
        })
      }
    }
    updateRef.current = updateGeometry
    update()
    const observer = new ResizeObserver(updateGeometry)
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
      observer.observe(parent)
    }
    ownerDocument.addEventListener('focusin', updateGeometry)
    ownerDocument.addEventListener('focusout', onFocusOut)
    window.addEventListener('resize', updateGeometry)
    window.addEventListener('scroll', updateGeometry, true)
    window.visualViewport?.addEventListener('resize', updateGeometry)
    window.visualViewport?.addEventListener('scroll', updateGeometry)
    return () => {
      disposed = true
      updateRef.current = null
      observer.disconnect()
      ownerDocument.removeEventListener('focusin', updateGeometry)
      ownerDocument.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('resize', updateGeometry)
      window.removeEventListener('scroll', updateGeometry, true)
      window.visualViewport?.removeEventListener('resize', updateGeometry)
      window.visualViewport?.removeEventListener('scroll', updateGeometry)
    }
  }, [anchorRef, keyboard])
  useLayoutEffect(() => {
    updateRef.current?.()
  })

  return placement
    ? createPortal(
        <View
          ref={setSurface}
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: placement.left,
            bottom: placement.bottom,
            width: placement.width,
            maxHeight: placement.maxHeight,
            overflow: 'hidden',
            zIndex: 1
          }}
        >
          {children}
        </View>,
        placement.root
      )
    : null
}
