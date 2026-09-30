// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, createRef, type ComponentType, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ScrollView } from 'react-native'
import { setTerminalSettingsScrollEnabled } from './terminal-settings-scroll-lock'
import { setTerminalSettingsScrollEnabled as setTerminalSettingsScrollEnabledOnWeb } from './terminal-settings-scroll-lock.web'

/** A ref holding whatever the platform hands back, which on RN Web is the DOM node. */
const refTo = (node: unknown): RefObject<ScrollView | null> => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  current: node as ScrollView | null
})

describe('the native scroll-lock write against an RN Web ref', () => {
  it('throws, because a DOM node has no setNativeProps', () => {
    expect(() =>
      setTerminalSettingsScrollEnabled(refTo(document.createElement('div')), false)
    ).toThrow(/setNativeProps is not a function/)
  })

  it('writes nothing at all when the view has not mounted', () => {
    expect(() => setTerminalSettingsScrollEnabled(refTo(null), false)).not.toThrow()
  })
})

describe('the web sibling', () => {
  it('locks the scroll with overflow, which stops a wheel as well as a touch drag', () => {
    const node = document.createElement('div')

    setTerminalSettingsScrollEnabledOnWeb(refTo(node), false)

    expect(node.style.overflowY).toBe('hidden')
  })

  it('tolerates a view that has unmounted between the gesture and the write', () => {
    expect(() => setTerminalSettingsScrollEnabledOnWeb(refTo(null), true)).not.toThrow()
  })

  it('leaves a node that is not an element alone', () => {
    expect(() => setTerminalSettingsScrollEnabledOnWeb(refTo({}), false)).not.toThrow()
  })
})

/**
 * The same writes against the component they are written for.
 *
 * The unlock is the half a hand-built `div` cannot answer. RN Web drives the scroller's overflow
 * from a generated class rather than an inline style, so clearing the inline value is what hands
 * it back; against a bare `div`, which has no class to fall back to, an unlock that wrote the
 * wrong thing would look the same as one that worked.
 */
describe('against a real react-native-web ScrollView', () => {
  /**
   * Loaded through `createRequire` rather than imported: react-native-web ships no type
   * declarations, so a bare import is an implicit `any` and drops this file out of the
   * tests-typecheck ratchet.
   */
  const {
    ScrollView: ReactNativeWebScrollView
  }: {
    ScrollView: ComponentType<{
      ref: RefObject<unknown>
    }>
  } = createRequire(import.meta.url)('react-native-web')

  async function renderScroller(): Promise<{
    node: HTMLElement
    unmount: () => void
  }> {
    // React 19 refuses `act` outside a test environment it has been told about.
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const ref: RefObject<unknown> = createRef()
    await act(async () => {
      root.render(createElement(ReactNativeWebScrollView, { ref }))
    })
    const node = ref.current
    if (!(node instanceof HTMLElement)) {
      throw new Error('react-native-web put no element in the ScrollView ref')
    }
    return {
      node,
      unmount: () => {
        root.unmount()
        container.remove()
      }
    }
  }

  it('is handed the DOM node itself, which is why the native write cannot land', async () => {
    const { node, unmount } = await renderScroller()
    try {
      expect(node.tagName).toBe('DIV')
      // `in` walks the prototype chain, so this says RN Web has no such method to inherit either.
      expect('setNativeProps' in node).toBe(false)
    } finally {
      unmount()
    }
  })

  it('locks and then hands the scroller back to the class RN Web styles it with', async () => {
    const { node, unmount } = await renderScroller()
    try {
      // The scroller's own overflow lives in a class, so there is nothing inline to save.
      expect(node.getAttribute('style')).toBeNull()
      expect(node.className).toContain('overflowY')

      setTerminalSettingsScrollEnabledOnWeb(refTo(node), false)
      expect(node.style.overflowY).toBe('hidden')

      setTerminalSettingsScrollEnabledOnWeb(refTo(node), true)
      expect(node.style.overflowY).toBe('')
      // And the class is still there to take over, which is what makes the line above an unlock
      // rather than an overflow nobody declares.
      expect(node.className).toContain('overflowY')
    } finally {
      unmount()
    }
  })
})
