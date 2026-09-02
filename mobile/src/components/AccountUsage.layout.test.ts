import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

import { UsageBar } from './AccountUsage'

describe('UsageBar layout', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('aligns reset text to a custom label width', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(UsageBar, {
          label: 'Cursor Models',
          labelWidth: 92,
          loading: false,
          resetText: 'Resets in 4 days',
          unavailable: false,
          usedPercent: 25
        })
      )
    })
    consoleError.mockRestore()

    const resetText = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === 'Resets in 4 days')
    expect(resetText?.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ marginLeft: 96 })])
    )
  })
})
