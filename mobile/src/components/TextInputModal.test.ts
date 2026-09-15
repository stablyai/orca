import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextInputModal } from './TextInputModal'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: unknown }) => children
}))

function renderModal(
  defaultValue: string,
  onSubmit = vi.fn(),
  onCancel = vi.fn()
): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(TextInputModal, {
        defaultValue,
        onCancel,
        onSubmit,
        title: 'Paste pairing code',
        visible: true
      })
    )
  })
  if (!renderer) {
    throw new Error('Text input modal did not render')
  }
  return renderer
}

function findAction(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const action = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === label)
  if (!action) {
    throw new Error(`${label} action did not render`)
  }
  return action
}

describe('TextInputModal actions', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enables a 44pt Save action after paste and submits its trimmed value', () => {
    const onSubmit = vi.fn()
    const renderer = renderModal('', onSubmit)
    const input = renderer.root.findByType('TextInput')

    expect(findAction(renderer, 'Save').props.disabled).toBe(true)
    act(() => input.props.onChangeText('  orca://pair?code=abc  '))
    const save = findAction(renderer, 'Save')

    expect(save.props.accessibilityRole).toBe('button')
    expect(save.props.disabled).toBe(false)
    expect(save.props.accessibilityState).toEqual({ disabled: false })
    expect(save.props.style({ pressed: false })[0]).toMatchObject({ minHeight: 44 })

    act(() => save.props.onPress())
    expect(onSubmit).toHaveBeenCalledWith('orca://pair?code=abc')
    act(() => renderer.unmount())
  })

  it('submits the trimmed value from the keyboard Return action', () => {
    const onSubmit = vi.fn()
    const renderer = renderModal('  bare-pairing-code  ', onSubmit)

    act(() => renderer.root.findByType('TextInput').props.onSubmitEditing())

    expect(onSubmit).toHaveBeenCalledWith('bare-pairing-code')
    act(() => renderer.unmount())
  })

  it('exposes a 44pt Cancel button and invokes cancellation', () => {
    const onCancel = vi.fn()
    const renderer = renderModal('pairing-code', vi.fn(), onCancel)
    const cancel = findAction(renderer, 'Cancel')

    expect(cancel.props.accessibilityRole).toBe('button')
    expect(cancel.props.style({ pressed: false })[0]).toMatchObject({ minHeight: 44 })
    act(() => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it('reports the Save action as disabled when validation blocks submission', () => {
    const onSubmit = vi.fn()
    const renderer = renderModal('   ', onSubmit)
    const save = findAction(renderer, 'Save')

    expect(save.props.disabled).toBe(true)
    expect(save.props.accessibilityState).toEqual({ disabled: true })
    act(() => renderer.root.findByType('TextInput').props.onSubmitEditing())
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
