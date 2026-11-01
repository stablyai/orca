import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TextInput } from 'react-native'

const COPIED_STYLES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'textIndent',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft'
] as const

// Measure a hidden copy: resizing the live textarea clamps scrolling ancestors in WebKit.
export function useTextInputContentHeight(
  input: RefObject<TextInput | null>,
  value: string
): number | undefined {
  const [height, setHeight] = useState<number>()
  const mirror = useRef<HTMLTextAreaElement | null>(null)
  const text = useRef(value)

  const measure = useCallback(() => {
    const source: unknown = input.current
    const copy = mirror.current
    if (!copy || !(source instanceof HTMLTextAreaElement) || source.clientWidth <= 0) {
      return
    }
    const computed = getComputedStyle(source)
    for (const property of COPIED_STYLES) {
      copy.style[property] = computed[property]
    }
    copy.style.width = `${source.clientWidth}px`
    // A trailing newline only takes up a line once something follows it.
    copy.value = text.current.endsWith('\n') ? `${text.current} ` : text.current
    // The copy has no border; the field's own border sits outside its scrollHeight.
    const border =
      Number.parseFloat(computed.borderTopWidth) + Number.parseFloat(computed.borderBottomWidth)
    setHeight(copy.scrollHeight + border)
  }, [input])

  useLayoutEffect(() => {
    const copy = document.createElement('textarea')
    copy.setAttribute('aria-hidden', 'true')
    copy.tabIndex = -1
    copy.readOnly = true
    copy.rows = 1
    Object.assign(copy.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      overflow: 'hidden',
      border: '0',
      margin: '0',
      boxSizing: 'border-box'
    })
    document.body.appendChild(copy)
    mirror.current = copy
    return () => {
      copy.remove()
      mirror.current = null
    }
  }, [])

  useLayoutEffect(() => {
    text.current = value
    measure()
  }, [value, measure])

  useEffect(() => {
    const source: unknown = input.current
    if (!(source instanceof HTMLTextAreaElement)) {
      return
    }
    let width = source.clientWidth
    const observer = new ResizeObserver(() => {
      if (source.clientWidth !== width) {
        width = source.clientWidth
        measure()
      }
    })
    observer.observe(source)
    return () => observer.disconnect()
  }, [input, measure])

  return height
}
