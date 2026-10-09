import { describe, expect, it } from 'vitest'
import { hdcTargetArgs, isLocalEmulatorTarget, parseHdcTargets } from './hdc-targets'

describe('hdc targets', () => {
  it('parses one connectKey per line', () => {
    const stdout = '127.0.0.1:5555\n127.0.0.1:10000 Connected\n'
    expect(parseHdcTargets(stdout)).toEqual(['127.0.0.1:5555', '127.0.0.1:10000'])
  })

  it('skips blank, bracketed and [Empty] lines', () => {
    const stdout = '[Empty]\n[Info:starting daemon]\n\nABC123USB456\n'
    expect(parseHdcTargets(stdout)).toEqual(['ABC123USB456'])
  })

  it('builds per-target args', () => {
    expect(hdcTargetArgs('127.0.0.1:5555', ['shell', 'pwd'])).toEqual([
      '-t',
      '127.0.0.1:5555',
      'shell',
      'pwd'
    ])
  })

  it('recognises loopback emulator targets', () => {
    expect(isLocalEmulatorTarget('127.0.0.1:5555')).toBe(true)
    expect(isLocalEmulatorTarget('10.0.0.1:5555')).toBe(false)
    expect(isLocalEmulatorTarget('ABC123')).toBe(false)
  })
})
