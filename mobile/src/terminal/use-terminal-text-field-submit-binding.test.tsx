import { createElement, forwardRef, useImperativeHandle, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalTextFieldSubmitBinding } from './use-terminal-text-field-submit-binding'

/**
 * The seam is mocked so the handler it was handed can be called on demand: the real one is a DOM
 * listener, and what is under test is which closure that listener reaches, on every platform.
 */
const mocks = vi.hoisted(() => {
  const boundHandlers: Array<() => void> = []
  return {
    boundHandlers,
    chordHandlers: new Array<(input: TerminalLiveAccessoryInput) => boolean>(),
    unbindCount: 0,
    releasedCount: 0
  }
})

vi.mock('./terminal-text-field-submit-binding', () => ({
  bindTerminalTextFieldSubmit: (
    _node: unknown,
    onSubmit: () => void,
    onChord: (input: TerminalLiveAccessoryInput) => boolean
  ) => {
    mocks.chordHandlers.push(onChord)
    mocks.boundHandlers.push(onSubmit)
    mocks.unbindCount += 1
    return () => {
      mocks.releasedCount += 1
    }
  }
}))

let submitted: string[] = []
const field: RefObject<TextInput | null> = { current: null }

/**
 * A caller handing the binding a fresh closure each render, which is what the command dock's two
 * fields do: their submits read `handleSend`, a per-render function whose guard reads `client` and
 * `activeHandle`. This says the listener follows them.
 */
let rebindField: ((node: TextInput | null) => void) | undefined

const Field = forwardRef<TextInput>(function Field(_props, ref) {
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
  rebindField = bindField
  return createElement(Field, { ref: bindField })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding never reads the node; the mocked seam only records the handler it was given.
const node = {} as TextInput

function reset(): void {
  submitted = []
  rebindField = undefined
  mocks.chordHandlers.length = 0
  mocks.boundHandlers.length = 0
  mocks.unbindCount = 0
  mocks.releasedCount = 0
}

describe('the terminal text field submit binding', () => {
  // The listener is attached once, so this says the ref behind it follows the caller's newest
  // closure rather than pinning the one the first render was given.
  it('calls the handler the newest commit supplied, not the first', () => {
    reset()
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Harness, { value: 'first' }))
    })
    act(() => {
      renderer?.update(createElement(Harness, { value: 'second' }))
    })
    act(() => {
      mocks.boundHandlers.at(-1)?.()
    })

    expect(submitted).toEqual(['second'])
    act(() => renderer?.unmount())
  })

  it('refreshes a keyboard chord handler after a terminal or connection change', () => {
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

  it('releases the previous listener before binding a node again', () => {
    reset()
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Harness, { value: 'first' }))
    })
    act(() => {
      renderer?.update(createElement(Harness, { value: 'second' }))
    })

    act(() => rebindField?.(node))

    // One binding remains live after an explicit rebind.
    expect(mocks.unbindCount - mocks.releasedCount).toBe(1)
    act(() => renderer?.unmount())
  })

  it('drops the binding when the field unmounts', () => {
    reset()
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Harness, { value: 'first' }))
    })
    act(() => {
      mocks.boundHandlers.at(-1)?.()
    })

    expect(submitted).toEqual(['first'])
    expect(field.current).toBe(node)
    act(() => renderer?.unmount())
    expect(field.current).toBeNull()
    expect(mocks.releasedCount).toBe(mocks.unbindCount)
  })
})
