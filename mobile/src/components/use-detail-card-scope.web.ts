import { useLayoutEffect, useRef } from 'react'
import type { DetailCardScopeOptions } from './use-detail-card-scope'

function element(value: unknown): HTMLElement | null {
  return value instanceof HTMLElement ? value : null
}

export function useDetailCardScope({
  active,
  obscured,
  openerRef,
  backRef,
  boundaryRefs,
  contentRef,
  dismiss
}: DetailCardScopeOptions): void {
  const saved = useRef<{ target: HTMLElement | null; restore: boolean } | null>(null)
  useLayoutEffect(() => {
    const opener = element(openerRef.current)
    const content = element(contentRef.current)
    if (!active) {
      const previous = saved.current
      saved.current = null
      if (!obscured && previous?.restore) {
        ;(previous.target?.isConnected ? previous.target : opener)?.focus()
      }
    }
    if (content) {
      content.inert = !active
    }
    if (!active || !opener || !content) {
      return
    }
    const record = {
      target: document.activeElement === document.body ? opener : element(document.activeElement),
      restore: true
    }
    saved.current = record
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (opener.contains(target) || content.contains(target))
    const headerBack = (target: EventTarget | null) =>
      target instanceof Node && element(backRef.current)?.contains(target)
    const listeners = new AbortController()
    const outside = () => {
      listeners.abort()
      record.restore = false
      dismiss()
    }
    const click = (event: MouseEvent) => {
      if (!inside(event.target) && !headerBack(event.target)) {
        outside()
      }
    }
    let backwards = false
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        backwards = event.shiftKey
      }
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.type === 'keyup') {
          dismiss()
        }
      }
    }
    // React handles local activation before terminal window shortcuts see the event.
    const isolate = (event: KeyboardEvent) => {
      if (inside(event.target)) {
        event.stopImmediatePropagation()
      }
    }
    const visible = (node: HTMLElement) => {
      let current: HTMLElement | null = node
      while (current) {
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false
        }
        current = current.parentElement
      }
      return true
    }
    const focusin = (event: FocusEvent) => {
      const index = boundaryRefs.current.indexOf(event.target)
      if (index !== -1) {
        if (!opener.isConnected || !content.isConnected) {
          return
        }
        if ((index === 0 && backwards) || (index === 3 && !backwards)) {
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              'a[href],button,input,select,textarea,[tabindex]'
            )
          ).filter(
            (node) =>
              node.tabIndex >= 0 &&
              !node.hasAttribute('disabled') &&
              !node.closest('[inert],[aria-hidden="true"],[hidden]') &&
              visible(node) &&
              !content.contains(node) &&
              !opener.contains(node)
          )
          const direction = backwards
            ? Node.DOCUMENT_POSITION_FOLLOWING
            : Node.DOCUMENT_POSITION_PRECEDING
          const adjacent = (backwards ? nodes.toReversed() : nodes).find((node) =>
            Boolean(node.compareDocumentPosition(opener) & direction)
          )
          outside()
          adjacent?.focus()
        } else if (index === 0 || (index === 2 && backwards)) {
          opener.focus()
        } else {
          content.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
        }
      } else if (!inside(event.target) && !headerBack(event.target)) {
        outside()
      }
    }
    const capture = { capture: true, signal: listeners.signal }
    document.addEventListener('click', click, capture)
    document.addEventListener('keydown', key, capture)
    document.addEventListener('keyup', key, capture)
    document.addEventListener('keydown', isolate, { signal: listeners.signal })
    document.addEventListener('keyup', isolate, { signal: listeners.signal })
    document.addEventListener('focusin', focusin, capture)
    content.focus()
    return () => listeners.abort()
  }, [active, obscured, openerRef, backRef, boundaryRefs, contentRef, dismiss])
}
