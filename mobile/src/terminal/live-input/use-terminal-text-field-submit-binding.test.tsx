import { createElement, forwardRef, useImperativeHandle, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInputInstance } from 'react-native'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalTextFieldSubmitBinding } from './use-terminal-text-field-submit-binding'

// Mock only the platform listener seam so tests can invoke the closure it actually captured.
const mocks = vi.hoisted(() => {
  return {
    chordHandlers: new Array<(input: TerminalLiveAccessoryInput) => boolean>()
  }
})

vi.mock('./terminal-text-field-submit-binding', () => ({
  bindTerminalTextFieldSubmit: (
    _node: unknown,
    _onSubmit: () => void,
    onChord: (input: TerminalLiveAccessoryInput) => boolean
  ) => {
    mocks.chordHandlers.push(onChord)
    return () => {}
  }
}))

let submitted: string[] = []
const field: RefObject<TextInputInstance | null> = { current: null }

const Field = forwardRef<TextInputInstance>(function Field(_props, ref) {
  useImperativeHandle(ref, () => node, [])
  return null
})

function Harness({ value }: { readonly value: string }) {
  const bindField = useTerminalTextFieldSubmitBinding(
    field,
    () => {
      submitted.push(value)
    },
    () => {
      submitted.push(value)
      return value === 'second'
    }
  )
  return createElement(Field, { ref: bindField })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding never reads the node; the mocked seam only records the handler it was given.
const node = {} as TextInputInstance

function reset(): void {
  submitted = []
  mocks.chordHandlers.length = 0
}

describe('the terminal text field submit binding', () => {
  it('refreshes a captured keyboard chord handler after a commit', () => {
    reset()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(createElement(Harness, { value: 'first' }))
    })
    const firstListener = mocks.chordHandlers[0]
    expect(firstListener?.({ bytes: '\x03' })).toBe(false)
    act(() => {
      renderer?.update(createElement(Harness, { value: 'second' }))
    })
    expect(firstListener?.({ bytes: '\x03' })).toBe(true)
    expect(submitted).toEqual(['first', 'second'])
    act(() => renderer?.unmount())
  })
})
