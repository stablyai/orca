import { describe, expect, it } from 'vitest'
import {
  classifyPosixPtySessionLiveness,
  readPosixPtySessionLiveness
} from './posix-pty-session-liveness'

const TABLE = `
  100 ttys001
  101 ttys001
  102 ttys001
  200 ttys002
  300 ??
`

describe('classifyPosixPtySessionLiveness', () => {
  it('reports live when peers share the root TTY', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 100, 999)).toBe('live')
  })

  it('reports empty when only the root remains on its TTY', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 200, 999)).toBe('empty')
  })

  it('reports gone when the root pid is absent', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 999, 998)).toBe('gone')
  })

  it('reports unknown for unbound ttys or a PTY shared with Orca itself', () => {
    expect(classifyPosixPtySessionLiveness(TABLE, 300, 999)).toBe('unknown')
    expect(classifyPosixPtySessionLiveness(TABLE, 100, 101)).toBe('unknown')
  })
})

describe('readPosixPtySessionLiveness', () => {
  it('never classifies Windows as empty', () => {
    expect(
      readPosixPtySessionLiveness(100, {
        platform: 'win32',
        readProcessTable: () => TABLE
      })
    ).toBe('unknown')
  })

  it('classifies through the injectable process-table seam', () => {
    expect(
      readPosixPtySessionLiveness(200, {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: () => TABLE
      })
    ).toBe('empty')
  })

  it('treats process-table failures as unknown, not empty', () => {
    expect(
      readPosixPtySessionLiveness(100, {
        platform: 'darwin',
        readProcessTable: () => {
          throw new Error('ps failed')
        }
      })
    ).toBe('unknown')
  })
})
