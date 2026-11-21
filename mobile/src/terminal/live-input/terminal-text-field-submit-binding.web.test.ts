// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TextInputInstance } from 'react-native'
import { hostOs } from '../../platform/host-os'
import { bindTerminalTextFieldSubmit as bindOnWeb } from './terminal-text-field-submit-binding.web'

vi.mock('../../platform/host-os', () => ({ hostOs: vi.fn(() => 'android') }))

const asField = (node: unknown): TextInputInstance | null =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  node as TextInputInstance | null

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

describe('the web sibling', () => {
  // IME candidate acceptance emits insertCompositionText, so it must not submit terminal input.
  it('leaves a composition commit alone', () => {
    const onSubmit = vi.fn()
    const field = mountField()
    bindOnWeb(asField(field), onSubmit)

    const event = sendBeforeInput(field, 'insertCompositionText')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('stops listening once the field is unbound', () => {
    const onSubmit = vi.fn()
    const field = mountField()

    bindOnWeb(asField(field), onSubmit)()
    sendBeforeInput(field, 'insertLineBreak')

    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('live terminal keyboard chords', () => {
  function setup(accept = true, platform: ReturnType<typeof hostOs> = 'android') {
    vi.mocked(hostOs).mockReturnValueOnce(platform)
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
    ['android', 'c', { ctrlKey: true }, '\x03'],
    ['ios', 'c', { ctrlKey: true }, '\x03'],
    ['android', 'Enter', { ctrlKey: true }, '\x1b[13;5u']
  ] as const)('claims %s %s once before RNWeb can resend it', (platform, name, options, bytes) => {
    const { field, onChord, key } = setup(true, platform)
    const parentKey = vi.fn()
    field.parentElement?.addEventListener('keydown', parentKey, { once: true })
    expect(key(name, options).defaultPrevented).toBe(true)
    expect(onChord).toHaveBeenCalledExactlyOnceWith({ bytes })
    expect(parentKey).not.toHaveBeenCalled()
  })

  it('keeps Option-generated text native on iOS and Alt chords on Android', () => {
    const android = setup(true, 'android')
    expect(android.key('b', { altKey: true }).defaultPrevented).toBe(true)
    expect(android.onChord).toHaveBeenCalledExactlyOnceWith({ bytes: '\x1bb' })

    const ios = setup(true, 'ios')
    expect(ios.key('b', { altKey: true }).defaultPrevented).toBe(false)
    expect(ios.onChord).not.toHaveBeenCalled()
  })

  it.each([
    ['Enter', { ctrlKey: true, shiftKey: true }],
    ['c', { ctrlKey: true, isComposing: true }],
    ['c', { ctrlKey: true, keyCode: 229 }],
    ['c', { ctrlKey: true, altKey: true }],
    ['c', { metaKey: true }],
    [' ', { ctrlKey: true }]
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
