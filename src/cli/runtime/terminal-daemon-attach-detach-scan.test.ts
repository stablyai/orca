import { describe, expect, it } from 'vitest'
import { scanForDetach } from './terminal-daemon-attach'

const CTRL_BACKSLASH = 0x1c
const Q = 0x71

describe('scanForDetach', () => {
  it('forwards ordinary bytes unchanged', () => {
    const r = scanForDetach(Buffer.from('ls\r'), false)
    expect(r.bytes).toEqual([...Buffer.from('ls\r')])
    expect(r.detached).toBe(false)
    expect(r.prefixPending).toBe(false)
  })

  it('detaches on Ctrl-\\ then q in one chunk', () => {
    const r = scanForDetach(Buffer.from([CTRL_BACKSLASH, Q]), false)
    expect(r.detached).toBe(true)
    expect(r.bytes).toEqual([])
  })

  it('forwards Ctrl-\\ followed by a non-q byte verbatim (both bytes)', () => {
    const r = scanForDetach(Buffer.from([CTRL_BACKSLASH, 0x61]), false)
    expect(r.detached).toBe(false)
    expect(r.bytes).toEqual([CTRL_BACKSLASH, 0x61])
    expect(r.prefixPending).toBe(false)
  })

  it('holds a lone trailing Ctrl-\\ across the chunk boundary', () => {
    const first = scanForDetach(Buffer.from([0x61, CTRL_BACKSLASH]), false)
    expect(first.bytes).toEqual([0x61])
    expect(first.prefixPending).toBe(true)
    // Next chunk's q completes the detach sequence.
    const second = scanForDetach(Buffer.from([Q]), first.prefixPending)
    expect(second.detached).toBe(true)
  })

  it('forwards a held Ctrl-\\ when the next chunk is not q', () => {
    const first = scanForDetach(Buffer.from([CTRL_BACKSLASH]), false)
    expect(first.prefixPending).toBe(true)
    expect(first.bytes).toEqual([])
    const second = scanForDetach(Buffer.from([0x62]), first.prefixPending)
    expect(second.detached).toBe(false)
    expect(second.bytes).toEqual([CTRL_BACKSLASH, 0x62])
  })
})
