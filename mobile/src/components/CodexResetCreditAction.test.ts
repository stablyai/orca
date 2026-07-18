import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexResetCreditAction } from './CodexResetCreditAction'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ RotateCcw: 'RotateCcw' }))

const summary = {
  availableCount: 1,
  availabilityLabel: '1 reset available',
  expiryLabel: 'Expires in 5d'
}

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

function renderAction(busy: boolean, disabled: boolean): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  const restore = suppressRendererWarning()
  try {
    act(() => {
      renderer = create(
        createElement(CodexResetCreditAction, {
          summary,
          scopeLabel: 'dev@example.com on the host',
          busy,
          disabled,
          onPress: vi.fn()
        })
      )
    })
  } finally {
    restore()
  }
  if (!renderer) {
    throw new Error('Reset action did not render')
  }
  return renderer
}

describe('CodexResetCreditAction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes a 44pt touch target and enabled accessibility state', () => {
    const renderer = renderAction(false, false)
    const button = renderer.root.findByType('Pressable')

    expect(button.props.accessibilityLabel).toBe('Use Codex rate-limit reset')
    expect(button.props.accessibilityState).toEqual({ busy: false, disabled: false })
    expect(button.props.accessibilityHint).toContain('dev@example.com on the host')
    expect(button.props.hitSlop).toBe(8)
    expect(button.props.style({ pressed: false })[0]).toMatchObject({ minHeight: 44 })
    act(() => renderer.unmount())
  })

  it('announces progress and visually dims a busy disabled action', () => {
    const renderer = renderAction(true, true)
    const button = renderer.root.findByType('Pressable')
    const text = renderer.root
      .findAllByType('Text')
      .map((node) => node.children.filter((child) => typeof child === 'string').join(''))

    expect(button.props.accessibilityLabel).toBe('Resetting Codex rate limits')
    expect(button.props.accessibilityState).toEqual({ busy: true, disabled: true })
    expect(button.props.style({ pressed: false })[1]).toMatchObject({ opacity: 0.5 })
    expect(text).toContain('Resetting…')
    act(() => renderer.unmount())
  })
})
