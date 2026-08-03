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

  it('omits logFilePath when --log-file is absent (adopted old daemons)', () => {
    const result = parseArgs(['--socket', '/tmp/t.sock', '--token', '/tmp/t.token'])
    expect(result).not.toHaveProperty('logFilePath')
  })

  it('parses --log-file when present', () => {
    const result = parseArgs([
      '--socket',
      '/tmp/t.sock',
      '--token',
      '/tmp/t.token',
      '--log-file',
      '/tmp/daemon.log'
    ])
    expect(result).toEqual({
      socketPath: '/tmp/t.sock',
      tokenPath: '/tmp/t.token',
      logFilePath: '/tmp/daemon.log'
    })
  })

  it('parses the internal PID-record ownership pair', () => {
    expect(
      parseArgs([
        '--socket',
        '/tmp/t.sock',
        '--token',
        '/tmp/t.token',
        '--pid-record',
        '/tmp/t.pid',
        '--launch-nonce',
        'launch-a'
      ])
    ).toEqual({
      socketPath: '/tmp/t.sock',
      tokenPath: '/tmp/t.token',
      pidPath: '/tmp/t.pid',
      launchNonce: 'launch-a'
    })
  })

  it('rejects either PID-record ownership argument without its pair', () => {
    expect(() =>
      parseArgs([
        '--socket',
        '/tmp/t.sock',
        '--token',
        '/tmp/t.token',
        '--pid-record',
        '/tmp/t.pid'
      ])
    ).toThrow('provided together')
    expect(() =>
      parseArgs([
        '--socket',
        '/tmp/t.sock',
        '--token',
        '/tmp/t.token',
        '--launch-nonce',
        'launch-a'
      ])
    ).toThrow('provided together')
  })

  it('still requires --socket and --token when --log-file is given', () => {
    expect(() => parseArgs(['--log-file', '/tmp/daemon.log'])).toThrow('Usage:')
  })

  it('parses the GUI-only --login-session-watch flag and omits it when absent', () => {
    expect(
      parseArgs(['--socket', '/tmp/t.sock', '--token', '/tmp/t.token', '--login-session-watch'])
    ).toEqual({
      socketPath: '/tmp/t.sock',
      tokenPath: '/tmp/t.token',
      loginSessionWatch: true
    })
    expect(parseArgs(['--socket', '/tmp/t.sock', '--token', '/tmp/t.token'])).not.toHaveProperty(
      'loginSessionWatch'
    )
  })
})
