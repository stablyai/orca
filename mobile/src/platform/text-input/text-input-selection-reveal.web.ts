import { useLayoutEffect, type RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import { copyTextInputStyles } from './text-input-content-height.web'

// A textarea exposes selection offsets, but no rectangle for its caret.
export function useTextInputSelectionReveal(input: RefObject<TextInputInstance | null>): void {
  useLayoutEffect(() => {
    const field: unknown = input.current
    if (!(field instanceof HTMLTextAreaElement)) {
      return
    }
    const copy = document.createElement('div')
    const caret = document.createElement('span')
    copy.setAttribute('aria-hidden', 'true')
    Object.assign(copy.style, {
      position: 'fixed',
      height: '0',
      overflow: 'hidden',
      top: '0',
      left: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      border: '0',
      margin: '0',
      boxSizing: 'border-box'
    })
    document.body.append(copy)
    let frame: number | null = null
    const reveal = () => {
      frame = null
      if (document.activeElement !== field || !field.isConnected || field.clientHeight <= 0) {
        return
      }
      copyTextInputStyles(field, copy)
      const selection =
        field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd
      copy.textContent = field.value.slice(0, selection)
      caret.textContent = field.value.slice(selection) || '\u200b'
      copy.append(caret)
      const rect = caret.getClientRects()[0]
      if (!rect) {
        return
      }
      const top = rect.top - copy.getBoundingClientRect().top
      const bottom = top + rect.height
      if (top < field.scrollTop) {
        field.scrollTop = top
      } else if (bottom > field.scrollTop + field.clientHeight) {
        field.scrollTop = bottom - field.clientHeight
      }
    }
    const schedule = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(reveal)
    }
    let width = field.clientWidth
    let height = field.clientHeight
    const observer = new ResizeObserver(() => {
      if (width !== field.clientWidth || height !== field.clientHeight) {
        width = field.clientWidth
        height = field.clientHeight
        schedule()
      }
    })
    observer.observe(field)
    field.addEventListener('select', schedule)
    field.addEventListener('input', schedule)
    field.addEventListener('compositionend', schedule)
    return () => {
      observer.disconnect()
      field.removeEventListener('select', schedule)
      field.removeEventListener('input', schedule)
      field.removeEventListener('compositionend', schedule)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      copy.remove()
    }
  }, [input])
}
