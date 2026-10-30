// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextInputProps } from 'react-native'
import { useHardwareKeyboardEnterSubmit } from './hardware-keyboard-enter-submit.web'

vi.mock('../../platform/host-os', () => ({ hostOs: () => 'ios' }))
vi.mock('../../platform/keyboard-occlusion', () => ({
  useSoftKeyboard: () => ({ height: 0, visible: false })
}))

// Require RN Web because it ships no type declarations; its own Enter handling decides whether the newline survives.
const { TextInput }: { TextInput: ComponentType<TextInputProps> } = createRequire(import.meta.url)(
  'react-native-web'
)

const roots: (() => Promise<void>)[] = []

async function mountComposer(onSubmit: () => void): Promise<HTMLTextAreaElement> {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Composer() {
    return createElement(TextInput, {
      multiline: true,
      ...useHardwareKeyboardEnterSubmit(onSubmit)
    })
  }
  await act(async () => root.render(createElement(Composer)))
  roots.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const field = container.querySelector('textarea')
  if (!field) {
    throw new Error('react-native-web did not render a textarea')
  }
  return field
}

function pressEnter(field: HTMLTextAreaElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  field.dispatchEvent(event)
  return event
}

afterEach(async () => {
  for (const unmount of roots.splice(0)) {
    await unmount()
  }
})

describe('hardware Return in the page composer', () => {
  it('sends on a plain Enter instead of inserting a newline', async () => {
    const onSubmit = vi.fn()
    const event = pressEnter(await mountComposer(onSubmit))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves Shift+Enter to insert its line break', async () => {
    const onSubmit = vi.fn()
    const event = pressEnter(await mountComposer(onSubmit), { shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not send while an IME is composing', async () => {
    const onSubmit = vi.fn()
    const event = pressEnter(await mountComposer(onSubmit), { isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
