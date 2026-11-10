// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { installBrowserGuestEditProtection } from './browser-guest-edit-protection'

it('preserves independent drafts and clears only controls a completed native reset discarded', async () => {
  vi.useFakeTimers()
  document.body.innerHTML =
    '<form id="a"><textarea>draft</textarea><div contenteditable></div></form><form id="b"><input></form><input form="a" id="external">'
  const formA = document.querySelector<HTMLFormElement>('#a')!
  const formB = document.querySelector<HTMLFormElement>('#b')!
  const draft = document.querySelector<HTMLTextAreaElement>('textarea')!
  const external = document.querySelector<HTMLInputElement>('#external')!
  const richText = document.querySelector<HTMLDivElement>('[contenteditable]')!
  const listeners = new Map<string, EventListener>()
  const addListener = vi
    .spyOn(document, 'addEventListener')
    .mockImplementation((name, listener) => {
      if (typeof listener === 'function') {
        listeners.set(name, listener)
      }
    })
  const send = vi.fn()
  let challenge: (value: unknown) => void = () => {}
  installBrowserGuestEditProtection({
    send,
    on: (_channel, listener) => {
      challenge = listener
    }
  })
  const dispatch = (
    name: string,
    target: Element,
    options: { isTrusted?: boolean; defaultPrevented?: boolean } = {}
  ): void => {
    listeners.get(name)?.({
      isTrusted: options.isTrusted ?? true,
      defaultPrevented: options.defaultPrevented ?? false,
      composedPath: () => [target]
    } as unknown as Event)
  }
  const lastReport = (): unknown => send.mock.lastCall?.[1]
  try {
    // Edits made before binding must appear in its first authenticated snapshot.
    dispatch('input', draft)
    challenge('document-1')
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: true })
    dispatch('reset', formB)
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: true })
    dispatch('reset', formA, { defaultPrevented: true })
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: true })
    dispatch('reset', formA)
    dispatch('input', draft)
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: true })
    dispatch('reset', formA)
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: false })
    dispatch('input', external)
    dispatch('reset', formA)
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: false })
    dispatch('input', richText)
    dispatch('reset', formA)
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'document-1', dirty: true })
    challenge('restored-document')
    expect(lastReport()).toEqual({ generation: 'restored-document', dirty: true })
    dispatch('reset', formA, { isTrusted: false })
    await vi.runAllTimersAsync()
    expect(lastReport()).toEqual({ generation: 'restored-document', dirty: true })
  } finally {
    addListener.mockRestore()
    document.body.replaceChildren()
    vi.useRealTimers()
  }
})
