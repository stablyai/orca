import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { View } from 'react-native'
import { useKeyboardOcclusion } from '../../../platform/keyboard-occlusion'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard-persisting-taps'
import { useMobileNativeChatLowerRegion } from '../mobile-native-chat-lower-region-context'
import { useMobileNativeChatComposerAllocation } from './MobileNativeChatComposerAllocation'
import type { ComposerMenuLayerProps } from './MobileNativeChatComposerMenuLayer'

type Placement = {
  root: HTMLElement
  left: number
  bottom: number
  width: number
  height: number
  reservedHeight?: number
  offset: number
}

export function MobileNativeChatComposerMenuLayer({ anchorRef, children }: ComposerMenuLayerProps) {
  const allocation = useMobileNativeChatComposerAllocation()
  const reserveRef = allocation?.reserveRef
  const onActiveChange = allocation?.onActiveChange
  const onIntrinsic = allocation?.onIntrinsic
  const keyboard = useKeyboardOcclusion()
  const lower = useMobileNativeChatLowerRegion()
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
  const measureIntrinsic = useCallback(() => {
    const card = surfaceRef.current?.querySelector<HTMLElement>(
      '[data-testid="native-chat-composer-menu-card"]'
    )
    const scroll = card?.firstElementChild
    const content = scroll?.firstElementChild
    const first = content?.firstElementChild
    if (!card || !(content instanceof HTMLElement) || !(first instanceof HTMLElement)) {
      return
    }
    const style = getComputedStyle(card)
    const chrome =
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0) +
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0) +
      (Number.parseFloat(style.marginBottom) || 0)
    onIntrinsic?.({ content: content.offsetHeight, chrome, firstGroup: first.offsetHeight })
  }, [onIntrinsic])

  useEffect(() => {
    const anchor: unknown = anchorRef.current
    if (!(anchor instanceof HTMLElement)) {
      return
    }
    const chat = anchor.closest<HTMLElement>('[data-testid="native-chat-view"]')
    if (!chat) {
      return
    }
    const document = anchor.ownerDocument
    let disposed = false
    const place = (next: Placement | null) =>
      setPlacement((current) =>
        current === next ||
        (current &&
          next &&
          current.root === next.root &&
          current.left === next.left &&
          current.bottom === next.bottom &&
          current.width === next.width &&
          current.height === next.height &&
          current.reservedHeight === next.reservedHeight &&
          current.offset === next.offset)
          ? current
          : next
      )
    const update = (target: EventTarget | null = document.activeElement) => {
      const moving = lower?.getContent()
      const host = lower ? (moving instanceof HTMLElement ? moving : null) : chat
      if (!host) {
        place(null)
        return
      }
      const ownFocus =
        target instanceof Node && (anchor.contains(target) || surfaceRef.current?.contains(target))
      const anchorRect = anchor.getBoundingClientRect()
      const active = Boolean(
        ownFocus && anchor.isConnected && anchorRect.width > 0 && anchorRect.height > 0
      )
      onActiveChange?.(active)
      if (!active) {
        place(null)
        return
      }
      const reserve: unknown = reserveRef?.current
      const reserved = reserve instanceof HTMLElement && reserve.offsetHeight > 0 ? reserve : null
      const rect = (reserved ?? anchor).getBoundingClientRect()
      const bounds = chat.getBoundingClientRect()
      const hostBounds = host.getBoundingClientRect()
      const page = window.visualViewport
      let top = Math.max(bounds.top, page?.offsetTop ?? 0)
      let bottom = Math.min(
        bounds.bottom,
        window.innerHeight - keyboard,
        page ? page.offsetTop + page.height : window.innerHeight
      )
      const actualViewport = lower?.getViewport()
      if (actualViewport instanceof HTMLElement) {
        const visible = actualViewport.getBoundingClientRect()
        top = Math.max(top, visible.top)
        bottom = Math.min(bottom, visible.bottom)
      }
      let visibleTop = top
      let visibleBottom = bottom
      for (
        let parent = (reserved ?? anchor).parentElement;
        parent && parent !== chat;
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
        rect.width <= 0 ||
        rect.height <= 0 ||
        visibleBottom <= visibleTop ||
        rect.bottom <= visibleTop ||
        rect.top >= visibleBottom
      ) {
        place(null)
        return
      }
      if (reserved) {
        const paintTop = Math.max(rect.top, visibleTop)
        const paintBottom = Math.min(rect.bottom, visibleBottom)
        place(
          paintBottom <= paintTop
            ? null
            : {
                root: host,
                left: rect.left - hostBounds.left,
                bottom: hostBounds.bottom - paintBottom,
                width: rect.width,
                height: paintBottom - paintTop,
                reservedHeight: rect.height,
                offset: rect.top - paintTop
              }
        )
      } else {
        const menuBottom = Math.max(rect.top, visibleTop)
        place({
          root: host,
          left: rect.left - hostBounds.left,
          bottom: hostBounds.bottom - menuBottom,
          width: rect.width,
          height: Math.max(0, menuBottom - top),
          offset: 0
        })
      }
    }
    const geometry = () => update()
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget) {
        update(event.relatedTarget)
      } else {
        queueMicrotask(() => {
          if (!disposed) {
            update()
          }
        })
      }
    }
    updateRef.current = geometry
    update()
    const observer = new ResizeObserver(geometry)
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
      observer.observe(parent)
    }
    document.addEventListener('focusin', geometry)
    document.addEventListener('focusout', onFocusOut)
    window.addEventListener('resize', geometry)
    window.addEventListener('scroll', geometry, true)
    window.visualViewport?.addEventListener('resize', geometry)
    window.visualViewport?.addEventListener('scroll', geometry)
    return () => {
      disposed = true
      updateRef.current = null
      observer.disconnect()
      document.removeEventListener('focusin', geometry)
      document.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('resize', geometry)
      window.removeEventListener('scroll', geometry, true)
      window.visualViewport?.removeEventListener('resize', geometry)
      window.visualViewport?.removeEventListener('scroll', geometry)
    }
  }, [anchorRef, reserveRef, onActiveChange, keyboard, lower?.getContent, lower?.getViewport])
  useLayoutEffect(() => () => onActiveChange?.(false), [onActiveChange])
  useLayoutEffect(() => {
    updateRef.current?.()
    measureIntrinsic()
  })
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    const card = surface?.querySelector('[data-testid="native-chat-composer-menu-card"]')
    const content = card?.firstElementChild?.firstElementChild
    if (!card || !content) {
      return
    }
    const observer = new ResizeObserver(measureIntrinsic)
    observer.observe(card)
    observer.observe(content)
    return () => observer.disconnect()
  }, [placement?.root, measureIntrinsic])

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
            maxHeight: placement.height,
            height: placement.reservedHeight === undefined ? undefined : placement.height,
            overflow: 'hidden',
            zIndex: 1
          }}
        >
          <View
            pointerEvents="box-none"
            style={
              placement.reservedHeight === undefined
                ? { flexShrink: 1, minHeight: 0 }
                : {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: placement.offset,
                    height: placement.reservedHeight
                  }
            }
          >
            {children}
          </View>
        </View>,
        placement.root
      )
    : null
}
