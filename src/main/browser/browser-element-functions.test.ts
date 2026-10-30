// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FILE_UPLOAD_TARGET_FUNCTION,
  FILL_ELEMENT_FUNCTION,
  SELECT_ALL_ELEMENT_FUNCTION,
  SELECT_OPTION_TARGET_FUNCTION
} from './browser-element-functions'

// CDP's Runtime.callFunctionOn calls the declaration with the resolved element as `this`.
function callOn(element: Element, declaration: string, ...args: unknown[]): unknown {
  return new Function(`return (${declaration})`)().apply(element, args)
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

describe('FILL_ELEMENT_FUNCTION', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('sets an input inside an open shadow root and fires one input and change event', () => {
    const host = mount('<div id="host"></div>').querySelector('#host')!
    const input = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('input'))
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))
    // Like a person's input, it crosses the shadow boundary for page-level listeners.
    document.addEventListener('input', () => events.push('document input'))

    expect(callOn(input, FILL_ELEMENT_FUNCTION, 'hello')).toBeNull()

    expect(input.value).toBe('hello')
    expect(events).toEqual(['input', 'document input', 'change'])
  })

  it.each([
    ['<h1>Title</h1>', 'h1', 'it is not a text field or editable element'],
    ['<input disabled>', 'input', 'it is disabled'],
    ['<textarea readonly></textarea>', 'textarea', 'it is read-only'],
    ['<input type="checkbox">', 'input', 'it is not a text field or editable element'],
    ['<select><option>a</option></select>', 'select', 'it is a <select>; use select instead']
  ])('refuses %s', (html, selector, reason) => {
    const element = mount(html).querySelector(selector)!

    expect(callOn(element, FILL_ELEMENT_FUNCTION, 'x')).toBe(reason)
  })

  it('keeps the previous value when a number field sanitizes the new one away', () => {
    const input = mount('<input type="number" value="42">').querySelector('input')!
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))

    expect(callOn(input, FILL_ELEMENT_FUNCTION, 'abc')).toBe('the field rejected this value')

    expect(input.value).toBe('42')
    expect(events).toEqual([])
  })

  it('fills the input an aria-controlled spinbutton points at', () => {
    const body = mount('<div role="spinbutton" aria-controls="qty"></div><input id="qty">')

    callOn(body.querySelector('[role=spinbutton]')!, FILL_ELEMENT_FUNCTION, '200')

    expect(body.querySelector<HTMLInputElement>('#qty')!.value).toBe('200')
  })

  it('fills the text descendant of a spinbutton wrapper, skipping non-text inputs', () => {
    const body = mount(
      '<div role="spinbutton"><input type="hidden" id="h"><input type="number" id="n"></div>'
    )

    callOn(body.querySelector('[role=spinbutton]')!, FILL_ELEMENT_FUNCTION, '7')

    expect(body.querySelector<HTMLInputElement>('#n')!.value).toBe('7')
    expect(body.querySelector<HTMLInputElement>('#h')!.value).toBe('')
  })

  it.each([
    ['replaces', 'new text', 'insertText'],
    ['clears', '', 'delete']
  ])('%s contenteditable text through a browser edit command', (_name, value, command) => {
    const editor = mount('<div contenteditable="true">old</div>').querySelector('div')!
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    expect(callOn(editor, FILL_ELEMENT_FUNCTION, value)).toBeNull()

    expect(execCommand).toHaveBeenCalledWith(command, false, value)
    expect(window.getSelection()?.toString()).toBe('old')
  })

  it('refuses a rich-text edit when a focus handler moves focus to another field', () => {
    const body = mount('<div contenteditable="true">old</div><input value="keep">')
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    body.querySelector('div')!.addEventListener('focus', () => body.querySelector('input')!.focus())

    expect(callOn(body.querySelector('div')!, FILL_ELEMENT_FUNCTION, 'new')).toBe(
      'it gave its focus to another element'
    )
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('refuses an input the page replaces when it takes focus', () => {
    const input = mount('<input value="old">').querySelector('input')!
    input.addEventListener('focus', () => input.replaceWith(document.createElement('input')))

    expect(callOn(input, FILL_ELEMENT_FUNCTION, 'new')).toMatch(/replaced it/)
  })

  it('reports a rich-text edit the browser refused', () => {
    const editor = mount('<div contenteditable="true">old</div>').querySelector('div')!
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })

    expect(callOn(editor, FILL_ELEMENT_FUNCTION, 'new')).toBe('the browser editing command failed')
  })
})

describe('element target checks', () => {
  it.each([
    ['<div role="combobox">Pick</div>', 'div', 'it is a combobox, not a <select>'],
    ['<h1>x</h1>', 'h1', 'it is <h1>, not a <select>'],
    ['<select disabled></select>', 'select', 'it is disabled']
  ])('refuses select on %s', (html, selector, reason) => {
    const element = mount(html).querySelector(selector)!

    expect(callOn(element, SELECT_OPTION_TARGET_FUNCTION)).toMatch(reason)
  })

  it('accepts select on an enabled <select>', () => {
    const select = mount('<select></select>').querySelector('select')!

    expect(callOn(select, SELECT_OPTION_TARGET_FUNCTION)).toBeNull()
  })

  it('takes a file input for upload as is and clicks any other element to open its picker', () => {
    const body = mount('<input type="file"><button>Attach</button>')
    const input = body.querySelector('input')!
    const button = body.querySelector('button')!
    const clicks: string[] = []
    input.addEventListener('click', () => clicks.push('input'))
    button.addEventListener('click', () => clicks.push('button'))

    expect(callOn(input, FILE_UPLOAD_TARGET_FUNCTION)).toBe(true)
    expect(callOn(button, FILE_UPLOAD_TARGET_FUNCTION)).toBe(false)
    expect(clicks).toEqual(['button'])
  })

  it('clicks an SVG picker control, which has no click() of its own', () => {
    const svg = mount('<svg role="button"></svg>').querySelector('svg')!
    let clicked = false
    document.body.addEventListener('click', () => (clicked = true))

    expect(callOn(svg, FILE_UPLOAD_TARGET_FUNCTION)).toBe(false)
    expect(clicked).toBe(true)
  })

  it('refuses upload on a disabled control without clicking it', () => {
    const body = mount('<input type="file" disabled><button disabled>Attach</button>')
    const button = body.querySelector('button')!
    let clicked = false
    button.addEventListener('click', () => (clicked = true))

    expect(callOn(body.querySelector('input')!, FILE_UPLOAD_TARGET_FUNCTION)).toBe('it is disabled')
    expect(callOn(button, FILE_UPLOAD_TARGET_FUNCTION)).toBe('it is disabled')
    expect(clicked).toBe(false)
  })

  it('selects all of an input value and reports that it holds focus', () => {
    const input = mount('<input value="abcdef">').querySelector('input')!
    input.setSelectionRange(3, 3)

    expect(callOn(input, SELECT_ALL_ELEMENT_FUNCTION)).toBe(true)

    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
  })
})
