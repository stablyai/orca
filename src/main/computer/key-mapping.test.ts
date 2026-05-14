import { describe, expect, it } from 'vitest'
import { parseKey } from './key-mapping'

describe('parseKey', () => {
  it.each([
    ['a', { key: 'a', modifiers: [] }],
    ['7', { key: '7', modifiers: [] }],
    [';', { key: ';', modifiers: [] }],
    ['Return', { key: 'Enter', modifiers: [] }],
    ['Escape', { key: 'Escape', modifiers: [] }],
    ['BackSpace', { key: 'Backspace', modifiers: [] }],
    ['Tab', { key: 'Tab', modifiers: [] }],
    ['space', { key: 'Space', modifiers: [] }],
    ['Page_Up', { key: 'PageUp', modifiers: [] }],
    ['Page_Down', { key: 'PageDown', modifiers: [] }],
    ['Home', { key: 'Home', modifiers: [] }],
    ['End', { key: 'End', modifiers: [] }],
    ['Up', { key: 'ArrowUp', modifiers: [] }],
    ['Down', { key: 'ArrowDown', modifiers: [] }],
    ['Left', { key: 'ArrowLeft', modifiers: [] }],
    ['Right', { key: 'ArrowRight', modifiers: [] }],
    ['Delete', { key: 'Delete', modifiers: [] }],
    ['Insert', { key: 'Insert', modifiers: [] }],
    ['F1', { key: 'F1', modifiers: [] }],
    ['F24', { key: 'F24', modifiers: [] }],
    ['KP_0', { key: 'Numpad0', modifiers: [] }],
    ['KP_9', { key: 'Numpad9', modifiers: [] }],
    ['KP_Add', { key: 'NumpadAdd', modifiers: [] }],
    ['KP_Subtract', { key: 'NumpadSubtract', modifiers: [] }],
    ['KP_Multiply', { key: 'NumpadMultiply', modifiers: [] }],
    ['KP_Divide', { key: 'NumpadDivide', modifiers: [] }],
    ['KP_Enter', { key: 'NumpadEnter', modifiers: [] }]
  ])('maps %s', (input, expected) => {
    expect(parseKey(input)).toEqual(expected)
  })

  it.each([
    ['ctrl+a', { key: 'a', modifiers: ['Ctrl'] }],
    ['control+a', { key: 'a', modifiers: ['Ctrl'] }],
    ['ctrl+shift+t', { key: 't', modifiers: ['Ctrl', 'Shift'] }],
    ['alt+F4', { key: 'F4', modifiers: ['Alt'] }],
    ['cmd+a', { key: 'a', modifiers: ['Meta'] }],
    ['command+a', { key: 'a', modifiers: ['Meta'] }],
    ['CmdOrCtrl+a', { key: 'a', modifiers: [process.platform === 'darwin' ? 'Meta' : 'Ctrl'] }],
    ['super+Left', { key: 'ArrowLeft', modifiers: ['Meta'] }],
    ['win+Right', { key: 'ArrowRight', modifiers: ['Meta'] }]
  ])('maps chord %s', (input, expected) => {
    expect(parseKey(input)).toEqual(expected)
  })

  it('rejects unknown modifiers and key names', () => {
    expect(() => parseKey('hyper+a')).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    expect(() => parseKey('NotAKey')).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    expect(() => parseKey('F25')).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
  })
})
