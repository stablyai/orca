// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TextInput } from 'react-native'
import { hostOs } from '../platform/host-os'
import { bindTerminalTextFieldSubmit } from './terminal-text-field-submit-binding'
import { bindTerminalTextFieldSubmit as bindOnWeb } from './terminal-text-field-submit-binding.web'

vi.mock('../platform/host-os', () => ({ hostOs: vi.fn(() => 'android') }))

const asField = (node: unknown): TextInput | null =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  node as TextInput | null

function mountField(): HTMLInputElement {
  const field = document.createElement('input')
  document.body.append(field)
  return field
}

function sendBeforeInput(field: HTMLElement, inputType: string): InputEvent {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })
  field.dispatchEvent(event)
  return event
}

describe('the native submit binding', () => {
  it('binds nothing, because the editor action already fires onSubmitEditing', () => {
    const onSubmit = vi.fn()
    const field = mountField()

    const unbind = bindTerminalTextFieldSubmit(asField(field), onSubmit)
    sendBeforeInput(field, 'insertLineBreak')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(() => unbind()).not.toThrow()
  })
})

describe('the web sibling', () => {
  it('submits on the line break the browser reports, and cancels it', () => {
    const onSubmit = vi.fn()
    const field = mountField()
    bindOnWeb(asField(field), onSubmit)

    const event = sendBeforeInput(field, 'insertLineBreak')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('submits a multiline field on its paragraph break', () => {
    const onSubmit = vi.fn()
    const field = document.createElement('textarea')
    document.body.append(field)
    bindOnWeb(asField(field), onSubmit)

    sendBeforeInput(field, 'insertParagraph')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  // IME candidate acceptance emits insertCompositionText, so it must not submit terminal input.
  it('leaves a composition commit alone', () => {
    const onSubmit = vi.fn()
    const field = mountField()
    bindOnWeb(asField(field), onSubmit)

    const event = sendBeforeInput(field, 'insertCompositionText')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores ordinary typing', () => {
    const onSubmit = vi.fn()
    const field = mountField()
    bindOnWeb(asField(field), onSubmit)

    sendBeforeInput(field, 'insertText')

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('stops listening once the field is unbound', () => {
    const onSubmit = vi.fn()
    const field = mountField()

    bindOnWeb(asField(field), onSubmit)()
    sendBeforeInput(field, 'insertLineBreak')

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('tolerates a field that never mounted', () => {
    expect(() => bindOnWeb(asField(null), vi.fn())()).not.toThrow()
  })

  it('leaves a node that is not a field alone', () => {
    const onSubmit = vi.fn()
    const div = document.createElement('div')
    document.body.append(div)

    bindOnWeb(asField(div), onSubmit)
    sendBeforeInput(div, 'insertLineBreak')

    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('live terminal keyboard chords', () => {
  function setup(accept = true) {
    const field = mountField()
    const onChord = vi.fn(() => accept)
    const unbind = bindOnWeb(asField(field), vi.fn(), onChord)
    const key = (name: string, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: name,
        ...options
      })
      // Happy DOM conflates Alt with AltGraph; browsers distinguish them.
      vi.spyOn(event, 'getModifierState').mockReturnValue(false)
      field.dispatchEvent(event)
      return event
    }
    return { field, onChord, unbind, key }
  }

  it.each([
    ['c', { ctrlKey: true }, '\x03'],
    ['Escape', {}, '\x1b'],
    ['Tab', {}, '\t'],
    ['Tab', { shiftKey: true }, '\x1b[Z'],
    ['ArrowUp', {}, '\x1b[A'],
    ['ArrowLeft', { ctrlKey: true }, '\x1b[1;5D'],
    ['b', { altKey: true }, '\x1bb']
  ])('claims %s once before RNWeb can resend it', (name, options, bytes) => {
    const { field, onChord, key } = setup()
    const parentKey = vi.fn()
    field.parentElement?.addEventListener('keydown', parentKey, { once: true })
    expect(key(name, options).defaultPrevented).toBe(true)
    expect(onChord).toHaveBeenCalledExactlyOnceWith({ bytes })
    expect(parentKey).not.toHaveBeenCalled()
  })

  it.each([
    ['a', {}],
    ['Enter', {}],
    ['Backspace', {}],
    ['Delete', {}],
    ['c', { ctrlKey: true, isComposing: true }],
    ['c', { ctrlKey: true, keyCode: 229 }],
    ['c', { ctrlKey: true, altKey: true }],
    ['c', { metaKey: true }],
    [' ', { ctrlKey: true }],
    ['1', { ctrlKey: true }]
  ])('leaves %s input and IME/platform shortcuts alone', (name, options) => {
    const { onChord, key } = setup()
    expect(key(name, options).defaultPrevented).toBe(false)
    expect(onChord).not.toHaveBeenCalled()
  })

  it('preserves an active composition even if the key event omits its flag', () => {
    const { field, onChord, key } = setup()
    field.dispatchEvent(new Event('compositionstart'))
    expect(key('Escape').defaultPrevented).toBe(false)
    field.dispatchEvent(new Event('compositionend'))
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(onChord).toHaveBeenCalledTimes(1)
  })

  it('leaves AltGraph text entry to the IME', () => {
    const { field, onChord } = setup()
    const event = new KeyboardEvent('keydown', { key: 'q', altKey: true, cancelable: true })
    vi.spyOn(event, 'getModifierState').mockReturnValue(true)
    field.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onChord).not.toHaveBeenCalled()
  })

  it.each(['ios', 'web'] as const)('leaves %s keyboard handling unchanged', (os) => {
    vi.mocked(hostOs).mockReturnValueOnce(os)
    const { key, onChord } = setup()
    expect(key('Tab').defaultPrevented).toBe(false)
    expect(key('c', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(onChord).not.toHaveBeenCalled()
  })

  it('does not swallow keys when the current terminal cannot send', () => {
    const { key } = setup(false)
    expect(key('Tab').defaultPrevented).toBe(false)
  })

  it('removes control listeners when the field unmounts', () => {
    const { onChord, unbind, key } = setup()
    unbind()
    expect(key('Escape').defaultPrevented).toBe(false)
    expect(onChord).not.toHaveBeenCalled()
  })
})
