import { describe, expect, it } from 'vitest'
import { parseArgs } from './daemon-entry'

describe('daemon-entry parseArgs', () => {
  it('parses --socket and --token flags', () => {
    const result = parseArgs(['--socket', '/tmp/test.sock', '--token', '/tmp/test.token'])
    expect(result).toEqual({
      socketPath: '/tmp/test.sock',
      tokenPath: '/tmp/test.token'
    })
  })

  it('handles flags in any order', () => {
    const result = parseArgs(['--token', '/tmp/t.token', '--socket', '/tmp/t.sock'])
    expect(result).toEqual({
      socketPath: '/tmp/t.sock',
      tokenPath: '/tmp/t.token'
    })
  })

  it('throws when --socket is missing', () => {
    expect(() => parseArgs(['--token', '/tmp/t.token'])).toThrow('Usage:')
  })

  it('throws when --token is missing', () => {
    expect(() => parseArgs(['--socket', '/tmp/t.sock'])).toThrow('Usage:')
  })

  it('throws with no args', () => {
    expect(() => parseArgs([])).toThrow('Usage:')
  })
})
