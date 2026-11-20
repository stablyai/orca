import { createElement, createRef } from 'react'
import type { TextInputInstance } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { findAllByHostType } from '../../test-support/react-test-renderer-host-nodes'
import { TextField } from './TextField'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    hairlineWidth: 1,
    absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }
  }
}))

describe('TextField', () => {
  it('focuses the inner TextInput when the field backdrop is pressed and forwards refs', () => {
    const focusSpy = vi.fn()
    const cleanupSpy = vi.fn()
    const callbackRef = vi.fn(() => cleanupSpy)
    const fakeNode = { focus: focusSpy }

    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(createElement(TextField, { inputRef: callbackRef, label: 'Live input' }), {
        createNodeMock: (element) => (element.type === 'TextInput' ? fakeNode : null)
      })
    })

    expect(callbackRef).toHaveBeenCalledWith(fakeNode)
    const backdrop = findAllByHostType(renderer!.root, 'Pressable')[0]
    expect(backdrop).toBeDefined()

    act(() => {
      backdrop!.props.onPress()
    })
    expect(focusSpy).toHaveBeenCalledOnce()

    const objectRef = createRef<TextInputInstance>()
    act(() => {
      renderer!.update(createElement(TextField, { inputRef: objectRef, label: 'Live input' }))
    })
    expect(cleanupSpy).toHaveBeenCalledOnce()
    expect<unknown>(objectRef.current).toBe(fakeNode)

    act(() => {
      backdrop!.props.onPress()
    })
    expect(focusSpy).toHaveBeenCalledTimes(2)
  })
})
