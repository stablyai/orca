import { describe, expect, it } from 'vitest'
import { acceptTerminalLayoutSeq } from './terminal-stream-layout'

describe('acceptTerminalLayoutSeq', () => {
  it('accepts a display-mode resize whose layout seq is below the scrollback output seq', () => {
    const marks = new Map<string, number>()
    expect(acceptTerminalLayoutSeq(marks, 't', { type: 'subscribed', seq: 2 })).toBe(true)
    expect(acceptTerminalLayoutSeq(marks, 't', { type: 'scrollback', seq: 14 })).toBe(true)
    expect(acceptTerminalLayoutSeq(marks, 't', { type: 'resized', seq: 3 })).toBe(true)
  })
})
