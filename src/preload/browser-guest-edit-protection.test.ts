// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { FILL_ELEMENT_FUNCTION } from '../main/browser/cdp/input/browser-element-functions'
import { installBrowserGuestEditProtection } from './browser-guest-edit-protection'

it('retains an agent-filled document through page handlers, reset and SPA field removal', () => {
  document.body.innerHTML = '<form><textarea>saved</textarea></form>'
  const form = document.querySelector<HTMLFormElement>('form')!
  const draft = document.querySelector<HTMLTextAreaElement>('textarea')!
  const addListener = vi.spyOn(window, 'addEventListener')
  let observerListeners: typeof addListener.mock.calls = []
  const send = vi.fn()
  let challenge: (value: unknown) => void = () => {}
  const stopPageEvent = (event: Event): void => event.stopPropagation()
  try {
    installBrowserGuestEditProtection({
      send,
      on: (_channel, listener) => {
        challenge = listener
      }
    })
    observerListeners = [...addListener.mock.calls]
    window.addEventListener('input', stopPageEvent, true)
    window.addEventListener('change', stopPageEvent, true)
    challenge('document-1')
    expect(send.mock.lastCall?.[1]).toEqual({ generation: 'document-1', dirty: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The production page function returns null on a successful fill or a refusal string.
    const fill = new Function(`return (${FILL_ELEMENT_FUNCTION})`)() as (
      this: Element,
      value: string
    ) => string | null
    expect(fill.call(draft, 'agent draft')).toBeNull()
    expect(draft.value).toBe('agent draft')
    expect(send.mock.lastCall?.[1]).toEqual({ generation: 'document-1', dirty: true })
    form.reset()
    expect(draft.value).toBe('saved')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.remove()
    challenge('same-document-rechallenge')
    expect(send.mock.lastCall?.[1]).toEqual({
      generation: 'same-document-rechallenge',
      dirty: true
    })
  } finally {
    for (const [name, listener, options] of observerListeners) {
      window.removeEventListener(name, listener, options)
    }
    window.removeEventListener('input', stopPageEvent, true)
    window.removeEventListener('change', stopPageEvent, true)
    addListener.mockRestore()
    document.body.replaceChildren()
  }
})
