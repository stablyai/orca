import { describe, expect, it } from 'vitest'
import {
  countTerminalGestureInputSequences,
  isTerminalGestureInput,
  splitTerminalGestureInput
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

  it('accepts SGR left-drag motion sequences but rejects a motion release', () => {
    expect(isTerminalGestureInput(`${ESC}[<32;10;5M${ESC}[<32;11;5M`)).toBe(true)
    expect(countTerminalGestureInputSequences(`${ESC}[<32;10;5M${ESC}[<32;11;5M`)).toBe(2)
    expect(isTerminalGestureInput(`${ESC}[<0;10;5M${ESC}[<32;11;5M${ESC}[<0;11;5m`)).toBe(true)
    expect(isTerminalGestureInput(`${ESC}[<32;10;5m`)).toBe(false)
  })

  it('accepts default-encoding left-drag motion sequences', () => {
    expect(isTerminalGestureInput(`${ESC}[M${String.fromCharCode(64, 43, 38)}`)).toBe(true)
    expect(
      isTerminalGestureInput(
        `${ESC}[M${String.fromCharCode(32, 33, 33)}${ESC}[M${String.fromCharCode(64, 34, 33)}${ESC}[M${String.fromCharCode(35, 34, 33)}`
      )
    ).toBe(true)
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

describe('splitTerminalGestureInput', () => {
  it('tells a button press or release from wheel, arrow and drag-motion reports', () => {
    const reports = splitTerminalGestureInput(
      `${ESC}[<64;3;4M${ESC}[A${ESC}[<0;3;4M${ESC}[<32;3;5M${ESC}[<0;3;5m${ESC}[M !!${ESC}[M#!!${ESC}[M\`!!`
    )

    expect(reports?.map((report) => report.kind)).toEqual([
      'movement',
      'movement',
      'click',
      'movement',
      'click',
      'click',
      'click',
      'movement'
    ])
    expect(reports?.map((report) => report.bytes).join('')).toContain(`${ESC}[<0;3;5m`)
  })

  it('refuses input the validator refuses', () => {
    expect(splitTerminalGestureInput(`${ESC}[Arm -rf`)).toBeNull()
    expect(splitTerminalGestureInput(`${ESC}[A`.repeat(33))).toBeNull()
  })

  it('gives wheel and arrow reports a direction that ignores where the finger was', () => {
    const directions = (bytes: string) =>
      splitTerminalGestureInput(bytes)?.map((report) => report.scrollDirection)

    expect(directions(`${ESC}[<64;3;4M${ESC}[<64;9;9M${ESC}[<65;3;4M`)).toEqual([
      `${ESC}[<64`,
      `${ESC}[<64`,
      `${ESC}[<65`
    ])
    expect(directions(`${ESC}[A${ESC}[B${ESC}OA`)).toEqual([`${ESC}[A`, `${ESC}[B`, `${ESC}OA`])
    expect(directions(`${ESC}[M\`!!${ESC}[M\`"#${ESC}[Ma!!`)).toEqual([
      `${ESC}[M\``,
      `${ESC}[M\``,
      `${ESC}[Ma`
    ])
    expect(directions(`${ESC}[<0;3;4M${ESC}[<32;3;5M${ESC}[M@!!`)).toEqual([
      undefined,
      undefined,
      undefined
    ])
  })
})
