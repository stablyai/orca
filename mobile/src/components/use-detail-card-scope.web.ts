import { useLayoutEffect, useRef } from 'react'
import type { DetailCardScopeOptions } from './use-detail-card-scope'

function element(value: unknown): HTMLElement | null {
  return value instanceof HTMLElement ? value : null
}

export function useDetailCardScope({
  present,
  obscured,
  openerRef,
  titleRef,
  layerRef,
  contentRef,
  dismiss
}: DetailCardScopeOptions): void {
  const savedFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const opener = element(openerRef.current)
    const title = element(titleRef.current)
    const layer = element(layerRef.current)
    const content = element(contentRef.current)
    let ancestor = layer?.parentElement
    while (ancestor && opener && !ancestor.contains(opener)) {
      ancestor = ancestor.parentElement
    }
    const root = ancestor
    if (obscured) {
      savedFocus.current = null
      return
    }
    if (!present) {
      if (
        savedFocus.current &&
        root?.isConnected &&
        (document.activeElement === document.body || root.contains(document.activeElement))
      ) {
        ;(savedFocus.current?.isConnected ? savedFocus.current : opener)?.focus()
      }
      savedFocus.current = null
      return
    }
    if (!opener || !title || !layer || !content || !root) {
      return
    }
    savedFocus.current =
      document.activeElement === document.body ? opener : element(document.activeElement)
    const restore: (() => void)[] = []
    const attribute = (node: HTMLElement, name: string, value: string) => {
      const previous = node.getAttribute(name)
      node.setAttribute(name, value)
      restore.push(() => {
        if (previous === null) {
          node.removeAttribute(name)
        } else {
          node.setAttribute(name, previous)
        }
      })
    }
    // Observe only the kept ancestry, so later header controls are excluded without watching terminal output.
    const masked = new WeakSet<HTMLElement>()
    const mask = (parent: HTMLElement): HTMLElement[] => {
      const nodes = [parent]
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement) || child === title || child === layer) {
          continue
        }
        if (child.contains(title) || child.contains(layer)) {
          nodes.push(...mask(child))
        } else if (!masked.has(child)) {
          masked.add(child)
          const inert = child.inert
          child.inert = true
          attribute(child, 'aria-hidden', 'true')
          restore.push(() => {
            child.inert = inert
          })
        }
      }
      return nodes
    }
    // The returned cleanup disconnects this observer; its callback only refreshes the same subscriptions.
    // react-doctor-disable-next-line react-doctor/effect-observer-needs-disconnect
    const observer = new MutationObserver(() => {
      for (const node of mask(root)) {
        observer.observe(node, { childList: true })
      }
    })
    for (const node of mask(root)) {
      observer.observe(node, { childList: true })
    }
    attribute(root, 'role', 'dialog')
    attribute(root, 'aria-modal', 'true')
    attribute(root, 'aria-label', title.textContent ?? '')
    const allowed = (target: EventTarget | null) =>
      target instanceof Node && (target === opener || content.contains(target))
    const focusable = () => [
      opener,
      ...Array.from(
        content.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')
      ).filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.hasAttribute('disabled') &&
          !node.closest('[inert],[aria-hidden="true"]')
      )
    ]
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const nodes = focusable()
        const index = nodes.indexOf(element(document.activeElement) ?? content)
        const next =
          index === -1
            ? event.shiftKey
              ? nodes.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length
        nodes[next]?.focus()
      }
    }
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        dismiss()
      }
    }
    // React receives opener activation first; keys then stop before window-level shortcuts.
    const isolate = (event: KeyboardEvent) => {
      if (allowed(event.target)) {
        event.stopImmediatePropagation()
      }
    }
    const focusin = (event: FocusEvent) => {
      if (!allowed(event.target)) {
        content.focus()
      }
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('keyup', keyup, true)
    document.addEventListener('keydown', isolate)
    document.addEventListener('keyup', isolate)
    document.addEventListener('focusin', focusin, true)
    content.focus()
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('keyup', keyup, true)
      document.removeEventListener('keydown', isolate)
      document.removeEventListener('keyup', isolate)
      document.removeEventListener('focusin', focusin, true)
      observer.disconnect()
      for (const undo of restore.toReversed()) {
        undo()
      }
    }
  }, [present, obscured, openerRef, titleRef, layerRef, contentRef, dismiss])
}
