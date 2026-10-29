import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextInput } from 'react-native'
import { MobileBrowserAddressField } from './MobileBrowserAddressField'

// Hoisted with the mock factory, which runs before every module-level const in this file.
const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('./MobileBrowserLoadProgress', () => ({ MobileBrowserLoadProgress: () => null }))

vi.mock('react-native', () => ({
  Platform: platform,
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

function addressInput(os: string): Record<string, unknown> {
  platform.OS = os
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(MobileBrowserAddressField, {
        disabled: false,
        focused: false,
        loading: false,
        loadFailed: false,
        onBlur: () => {},
        onChangeText: () => {},
        onFocus: () => {},
        onSubmit: () => {},
        value: 'https://dashboard.example'
      })
    )
  })
  if (renderer === null) {
    throw new Error('nothing mounted')
  }
  const mounted: ReactTestRenderer = renderer
  // Find imported component, not host string: React ElementType rejects TextInput string and would drop this test from typecheck ratchet.
  return mounted.root.findByType(TextInput).props
}

afterEach(() => {
  platform.OS = 'ios'
})

describe('the address field keyboard', () => {
  // Browser ignores native keyboardType; inputMode must preserve URL keys.
  it('asks for the URL keyboard through inputMode on the web', () => {
    expect(addressInput('web').inputMode).toBe('url')
  })

  // Keep native inputMode undefined: it overrides keyboardType and would replace iOS URL keyboard.
  it('leaves inputMode unset on both native platforms', () => {
    expect(addressInput('ios').inputMode).toBeUndefined()
    expect(addressInput('ios').keyboardType).toBe('url')
    expect(addressInput('android').inputMode).toBeUndefined()
    expect(addressInput('android').keyboardType).toBe('default')
  })
})
