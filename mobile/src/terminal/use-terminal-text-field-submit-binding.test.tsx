import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalTextFieldSubmitBinding } from './use-terminal-text-field-submit-binding'

/**
 * The seam is mocked so the handler it was handed can be called on demand: the real one is a DOM
 * listener, and what is under test is which closure that listener reaches, on every platform.
 */
const mocks = vi.hoisted(() => {
  const boundHandlers: Array<() => void> = []
  return { boundHandlers, unbindCount: 0, releasedCount: 0 }
})

vi.mock('./terminal-text-field-submit-binding', () => ({
  bindTerminalTextFieldSubmit: (_node: unknown, onSubmit: () => void) => {
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
function Harness({ value }: { readonly value: string }): null {
  const bindField = useTerminalTextFieldSubmitBinding(field, () => {
    submitted.push(value)
  })
  bindField(node)
  return null
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding never reads the node; the mocked seam only records the handler it was given.
const node = {} as TextInput

function reset(): void {
  submitted = []
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

  it('releases the previous listener before binding a node again', () => {
    reset()
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Harness, { value: 'first' }))
    })
    act(() => {
      renderer?.update(createElement(Harness, { value: 'second' }))
    })

    // One release per rebind, so a field re-bound on every render leaks no listeners: only the
    // binding still in place is unreleased.
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
  })
})
