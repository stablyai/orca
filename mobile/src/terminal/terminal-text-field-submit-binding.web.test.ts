// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TextInput } from 'react-native'
import { bindTerminalTextFieldSubmit } from './terminal-text-field-submit-binding'
import { bindTerminalTextFieldSubmit as bindOnWeb } from './terminal-text-field-submit-binding.web'

/** A ref holding whatever the platform hands back, which on RN Web is the DOM node. */
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

  // RN Web renders a multiline field as a textarea, where the same keystroke is a paragraph.
  it('submits a multiline field on its paragraph break', () => {
    const onSubmit = vi.fn()
    const field = document.createElement('textarea')
    document.body.append(field)
    bindOnWeb(asField(field), onSubmit)

    sendBeforeInput(field, 'insertParagraph')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  /**
   * The case the brief guards: an IME still choosing a candidate reports its commit as
   * `insertCompositionText`, and Enter there belongs to the keyboard, not to the terminal.
   */
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

  // A release that wrapped the field in something other than a form control is left alone rather
  // than given a listener that could never see a line break.
  it('leaves a node that is not a field alone', () => {
    const onSubmit = vi.fn()
    const div = document.createElement('div')
    document.body.append(div)

    bindOnWeb(asField(div), onSubmit)
    sendBeforeInput(div, 'insertLineBreak')

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
