import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
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
    const update = () => {
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
    update()
    const observer = new ResizeObserver(update)
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
      observer.observe(parent)
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [anchorRef, keyboard])

  return placement
    ? createPortal(
        <View
          ref={keepKeyboard}
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
