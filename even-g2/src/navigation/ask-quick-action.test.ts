import { describe, expect, it } from 'vitest'
import {
  askDigitCount,
  askQuickActionToKeys,
  askStripSlotCount,
  clampAskCursor,
  resolveAskQuickAction
} from './ask-quick-action'

describe('askQuickActionToKeys', () => {
  it('encodes an option digit as "<n>\\r"', () => {
    expect(askQuickActionToKeys({ kind: 'option', digit: 1 })).toBe('1\r')
    expect(askQuickActionToKeys({ kind: 'option', digit: 3 })).toBe('3\r')
  })

  it('encodes enter as "\\r"', () => {
    expect(askQuickActionToKeys({ kind: 'enter' })).toBe('\r')
  })

  it('encodes escape as "\\x1b"', () => {
    expect(askQuickActionToKeys({ kind: 'escape' })).toBe('\x1b')
  })
})

describe('askDigitCount / askStripSlotCount', () => {
  it('clamps digit options to the 1-4 range', () => {
    expect(askDigitCount(0)).toBe(0)
    expect(askDigitCount(2)).toBe(2)
    expect(askDigitCount(4)).toBe(4)
    expect(askDigitCount(9)).toBe(4)
    expect(askDigitCount(-3)).toBe(0)
  })

  it('adds Enter + Esc slots to the digit count', () => {
    expect(askStripSlotCount(3)).toBe(5)
    expect(askStripSlotCount(0)).toBe(2)
  })
})

describe('clampAskCursor', () => {
  it('clamps to [0, slotCount-1] without wrapping', () => {
    expect(clampAskCursor(-1, 3)).toBe(0)
    expect(clampAskCursor(0, 3)).toBe(0)
    expect(clampAskCursor(4, 3)).toBe(4)
    expect(clampAskCursor(5, 3)).toBe(4)
  })
})

describe('resolveAskQuickAction', () => {
  it('maps the first optionCount slots to option digits 1..n', () => {
    expect(resolveAskQuickAction(0, 3)).toEqual({ kind: 'option', digit: 1 })
    expect(resolveAskQuickAction(1, 3)).toEqual({ kind: 'option', digit: 2 })
    expect(resolveAskQuickAction(2, 3)).toEqual({ kind: 'option', digit: 3 })
  })

  it('maps the slot right after the digits to enter', () => {
    expect(resolveAskQuickAction(3, 3)).toEqual({ kind: 'enter' })
  })

  it('maps the last slot to escape', () => {
    expect(resolveAskQuickAction(4, 3)).toEqual({ kind: 'escape' })
  })
})
