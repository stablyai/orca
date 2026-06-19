import { describe, expect, it } from 'vitest'
import {
  countTerminalGestureInputSequences,
  isTerminalGestureInput
} from './terminal-gesture-input'

const ESC = '\x1b'

describe('isTerminalGestureInput', () => {
  it('accepts repeated arrow scroll sequences', () => {
    expect(isTerminalGestureInput(`${ESC}[A${ESC}[B${ESC}OA${ESC}OB`)).toBe(true)
    expect(isTerminalGestureInput(`${ESC}[A`.repeat(32))).toBe(true)
    expect(countTerminalGestureInputSequences(`${ESC}[A${ESC}[B${ESC}OA${ESC}OB`)).toBe(4)
    expect(countTerminalGestureInputSequences(`${ESC}[A`.repeat(32))).toBe(32)
  })

  it('accepts repeated SGR wheel sequences', () => {
    expect(isTerminalGestureInput(`${ESC}[<64;1;1M${ESC}[<65;120;40M`)).toBe(true)
    expect(isTerminalGestureInput(`${ESC}[<64;0;0M`)).toBe(true)
  })

  it('accepts bounded SGR left-click press and release sequences', () => {
    expect(isTerminalGestureInput(`${ESC}[<0;38;20M${ESC}[<0;38;20m`)).toBe(true)
    expect(countTerminalGestureInputSequences(`${ESC}[<0;38;20M${ESC}[<0;38;20m`)).toBe(2)
    expect(countTerminalGestureInputSequences(`${ESC}[<0;1;1M${ESC}[<0;1;1m`)).toBe(2)
    expect(countTerminalGestureInputSequences(`${ESC}[<0;0;0M${ESC}[<0;0;0m`)).toBe(2)
    expect(isTerminalGestureInput(`${ESC}[<0;9999;9999M${ESC}[<0;9999;9999m`)).toBe(true)
  })

  it('accepts repeated default mouse wheel sequences', () => {
    expect(
      isTerminalGestureInput(
        `${ESC}[M${String.fromCharCode(96, 97, 33)}${ESC}[M${String.fromCharCode(97, 126, 126)}`
      )
    ).toBe(true)
  })

  it('accepts bounded default left-click press and release sequences', () => {
    expect(
      isTerminalGestureInput(
        `${ESC}[M${String.fromCharCode(32, 33, 33)}${ESC}[M${String.fromCharCode(35, 33, 33)}`
      )
    ).toBe(true)
  })

  it('rejects shell text and other terminal input', () => {
    expect(isTerminalGestureInput('rm -rf .\r')).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[200~paste${ESC}[201~`)).toBe(false)
  })

  it('rejects malformed or oversized sequences', () => {
    expect(isTerminalGestureInput(`${ESC}[<63;0;1M`)).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[M` + String.fromCharCode(97, 32, 33))).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[A`.repeat(33))).toBe(false)
    expect(countTerminalGestureInputSequences(`${ESC}[A`.repeat(33))).toBeNull()
    expect(isTerminalGestureInput(`${ESC}[A`.repeat(700))).toBe(false)
  })

  it('rejects malformed SGR click reports and wheel releases', () => {
    expect(isTerminalGestureInput(`${ESC}[<0;;1M`)).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[<0;-1;1M`)).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[<0;10000;1M`)).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[<64;1;1m`)).toBe(false)
    expect(isTerminalGestureInput(`${ESC}[<65;1;1m`)).toBe(false)
  })
})
