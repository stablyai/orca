import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const saveMock = vi.hoisted(() => vi.fn<(enabled: boolean) => Promise<void>>())

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))

vi.mock('../storage/preferences', () => ({
  loadTerminalKeyboardResizeEnabled: loadMock,
  saveTerminalKeyboardResizeEnabled: saveMock
}))

import { TerminalKeyboardResizeSetting } from './TerminalKeyboardResizeSetting'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  loadMock.mockReset()
  saveMock.mockReset()
})

async function mount(stored: boolean) {
  loadMock.mockReturnValueOnce(Promise.resolve(stored))
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(TerminalKeyboardResizeSetting))
  })
  renderers.push(renderer)
  const switchEl = () =>
    renderer.root.find((node) => typeof node.props.onValueChange === 'function')
  const toggle = (next: boolean) => {
    act(() => {
      switchEl().props.onValueChange(next)
    })
  }
  return { switchEl, toggle }
}

describe('TerminalKeyboardResizeSetting', () => {
  it('lands the switch on what storage kept after a refused write', async () => {
    const save = deferred<void>()
    const { switchEl, toggle } = await mount(false)
    saveMock.mockImplementationOnce(() => save.promise)
    toggle(true)
    expect(switchEl().props.value).toBe(true)

    save.reject(new Error('denied'))
    loadMock.mockReturnValueOnce(Promise.resolve(false))
    await act(async () => {})
    // The write kept nothing, so the read-back returns the switch to Off.
    expect(switchEl().props.value).toBe(false)
  })

  it('lets a newer toggle supersede an older failure read-back', async () => {
    const saveA = deferred<void>()
    const { switchEl, toggle } = await mount(false)
    saveMock.mockImplementationOnce(() => saveA.promise)
    toggle(true)
    saveMock.mockImplementationOnce(() => Promise.resolve())
    toggle(false)
    expect(switchEl().props.value).toBe(false)

    // The first toggle's write refuses late; its read-back must not overwrite the second toggle.
    loadMock.mockReturnValueOnce(Promise.resolve(true))
    saveA.reject(new Error('denied'))
    await act(async () => {})
    expect(switchEl().props.value).toBe(false)
  })
})
