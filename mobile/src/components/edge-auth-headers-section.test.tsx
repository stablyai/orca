import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const keyboardListeners = vi.hoisted(() => {
  const state: { show: null | ((height: number) => void) } = { show: null }
  return state
})
const scroller = vi.hoisted(() => ({
  scrollResponderScrollNativeHandleToKeyboard: vi.fn()
}))
const readHeaders = vi.hoisted(() => vi.fn(async () => null))

vi.mock('react-native', () => ({
  findNodeHandle: () => 123,
  Keyboard: {
    addListener: (event: string, callback: (e: { endCoordinates: { height: number } }) => void) => {
      if (event === 'keyboardWillShow') {
        keyboardListeners.show = (height: number) => callback({ endCoordinates: { height } })
      }
      return { remove: () => {} }
    }
  },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('../platform/keyboard-occlusion', () => ({
  subscribeSoftKeyboard: (
    onShow: (height: number, duration: number) => void,
    _onHide: (duration: number) => void
  ) => {
    keyboardListeners.show = (height: number) => onShow(height, 0)
    return () => {
      keyboardListeners.show = null
    }
  }
}))

vi.mock('../transport/endpoint-auth-headers-store', () => ({
  readEndpointAuthHeaders: readHeaders,
  writeEndpointAuthHeaders: async () => {},
  deleteEndpointAuthHeaders: async () => {}
}))

import {
  EdgeAuthHeadersSection,
  newEdgeAuthRow,
  useEdgeAuthHeaders
} from './edge-auth-headers-section'
import type { ReactTestRenderer } from 'react-test-renderer'
import { applyMobileColorScheme, paletteForScheme } from '../theme/mobile-theme'

function requireRenderer(value: ReactTestRenderer | null): ReactTestRenderer {
  if (!value) {
    throw new Error('section did not render')
  }
  return value
}

describe('edge auth headers section keyboard', () => {
  it('keeps credential fields readable when the phone color scheme changes', async () => {
    let renderer: ReactTestRenderer | null = null
    const props = {
      rows: [{ ...newEdgeAuthRow(), name: 'X-Token', value: 'synthetic-secret' }],
      storedCount: 1,
      error: null,
      onRowsChange: () => {},
      scrollViewRef: { current: scroller }
    }
    try {
      for (const scheme of ['light', 'dark'] as const) {
        applyMobileColorScheme(scheme)
        await act(async () => {
          if (renderer) {
            renderer.update(createElement(EdgeAuthHeadersSection, props))
          } else {
            renderer = create(createElement(EdgeAuthHeadersSection, props))
          }
        })
        const inputs = requireRenderer(renderer).root.findAll(
          (node) => String(node.type) === 'TextInput'
        )
        expect(inputs[0]?.props.style[0].backgroundColor).toBe(paletteForScheme(scheme).bgPanel)
        expect(inputs[1]?.props.secureTextEntry).toBe(true)
      }
    } finally {
      applyMobileColorScheme('dark')
      act(() => renderer?.unmount())
    }
  })

  it('scrolls the focused row into view when the keyboard lands', async () => {
    scroller.scrollResponderScrollNativeHandleToKeyboard.mockClear()
    const scrollViewRef = { current: scroller }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(EdgeAuthHeadersSection, {
          rows: [{ ...newEdgeAuthRow(), name: 'CF-Access-Client-Id', value: 'secret' }],
          storedCount: 1,
          error: null,
          onRowsChange: () => {},
          scrollViewRef
        }),
        // Why: host-element refs only attach with a node mock in this renderer.
        { createNodeMock: () => ({}) }
      )
      await Promise.resolve()
    })

    // Why: findAllByType takes a component, and the mocks render host strings.
    const inputs = requireRenderer(renderer).root.findAll(
      (node) => String(node.type) === 'TextInput'
    )
    expect(inputs).toHaveLength(2)
    await act(async () => {
      inputs[1]?.props.onFocus()
      await Promise.resolve()
    })
    keyboardListeners.show?.(300)

    expect(scroller.scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      123,
      expect.any(Number),
      true
    )
    act(() => requireRenderer(renderer).unmount())
  })

  it('scrolls immediately on focus when the keyboard is already open', async () => {
    scroller.scrollResponderScrollNativeHandleToKeyboard.mockClear()
    const scrollViewRef = { current: scroller }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(EdgeAuthHeadersSection, {
          rows: [{ ...newEdgeAuthRow(), name: '', value: '' }],
          storedCount: 0,
          error: null,
          onRowsChange: () => {},
          scrollViewRef
        }),
        // Why: host-element refs only attach with a node mock in this renderer.
        { createNodeMock: () => ({}) }
      )
      await Promise.resolve()
    })
    const root = requireRenderer(renderer).root
    const inputs = root.findAll((node) => String(node.type) === 'TextInput')
    expect(inputs).toHaveLength(2)
    await act(async () => {
      inputs[0]?.props.onFocus()
      await Promise.resolve()
    })

    // Why: no keyboard show event fires here — the scroll must happen on focus alone.
    expect(scroller.scrollResponderScrollNativeHandleToKeyboard).toHaveBeenCalledWith(
      123,
      expect.any(Number),
      true
    )
    act(() => requireRenderer(renderer).unmount())
  })
})

it("clears another host's rows before an unreadable credential load", async () => {
  let state: ReturnType<typeof useEdgeAuthHeaders> | undefined
  function Harness() {
    state = useEdgeAuthHeaders()
    return null
  }
  const current = () => {
    if (!state) {
      throw new Error('Hook not rendered')
    }
    return state
  }
  let renderer: ReactTestRenderer | null = null
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    act(() =>
      current().setAuthRows([{ ...newEdgeAuthRow(), name: 'X-Token', value: 'old-secret' }])
    )
    expect(current().authChanged).toBe(true)
    readHeaders.mockRejectedValueOnce(new Error('Keychain locked'))
    await act(async () => {
      await expect(current().loadAuthForHost('other-host', 'wss://other.example')).rejects.toThrow()
    })
    expect(current().authNormalized).toEqual({ ok: true, headers: {} })
    expect(current().authChanged).toBe(false)
    expect(current().storedAuthCount).toBe(0)
    expect(current().authLoaded).toBe(false)
    await act(async () => {
      await current().loadAuthForHost('other-host', 'wss://other.example')
    })
    expect(current().authLoaded).toBe(true)
  } finally {
    act(() => renderer?.unmount())
  }
})
