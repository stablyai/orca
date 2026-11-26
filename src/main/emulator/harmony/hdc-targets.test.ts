import { describe, expect, it } from 'vitest'
import {
  hdcTargetArgs,
  isLocalEmulatorTarget,
  listTargetsVerboseArgs,
  offlineLocalConnectKeys,
  parseHdcTargets,
  parseHdcVerboseTargets,
  removeTargetArgs
} from './hdc-targets'

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

  it('exposes the verbose listing and removal argv', () => {
    expect(listTargetsVerboseArgs).toEqual(['list', 'targets', '-v'])
    expect(removeTargetArgs('127.0.0.1:10000')).toEqual(['tconn', '127.0.0.1:10000', '-remove'])
  })

  it('parses verbose target rows including Offline residue', () => {
    const stdout = [
      '127.0.0.1:10000\t\tTCP\tOffline\tunknown...\thdc',
      '127.0.0.1:5555\t\tTCP\tConnected\tlocalhost\thdc',
      '[Empty]',
      ''
    ].join('\n')
    expect(parseHdcVerboseTargets(stdout)).toEqual([
      { connectKey: '127.0.0.1:10000', state: 'offline' },
      { connectKey: '127.0.0.1:5555', state: 'connected' }
    ])
  })

  it('keeps only local loopback targets for Offline pruning', () => {
    const targets = parseHdcVerboseTargets(
      [
        '127.0.0.1:10000 TCP Offline unknown... hdc',
        '127.0.0.1:5555 TCP Connected localhost hdc',
        '192.168.1.9:5555 TCP Offline phone hdc'
      ].join('\n')
    )
    expect(offlineLocalConnectKeys(targets)).toEqual(['127.0.0.1:10000'])
  })
})
