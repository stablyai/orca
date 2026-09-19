import { describe, expect, it } from 'vitest'
import {
  isOpenCodeClientArgv,
  parseCimArgsLine,
  parsePsArgsLine,
  parsePsElapsedToMs
} from './opencode-client-sweep'

const NOW = 1_700_000_000_000

describe('parsePsElapsedToMs', () => {
  it('reads mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parsePsElapsedToMs('02:11', NOW)).toBe(NOW - 131_000)
    expect(parsePsElapsedToMs('1:02:11', NOW)).toBe(NOW - 3_731_000)
    expect(parsePsElapsedToMs('2-01:02:11', NOW)).toBe(NOW - 176_531_000)
  })

  it('rejects unknown shapes', () => {
    expect(parsePsElapsedToMs('', NOW)).toBeNull()
    expect(parsePsElapsedToMs('yesterday', NOW)).toBeNull()
  })
})

describe('parsePsArgsLine', () => {
  it('parses a client row', () => {
    const row = parsePsArgsLine('23487 22618 2:11:51 opencode', NOW)
    expect(row).toMatchObject({ pid: 23487, ppid: 22618, argv: ['opencode'] })
    expect(row?.startedAtMs).toBe(NOW - (2 * 3_600 + 11 * 60 + 51) * 1000)
  })

  it('keeps session flags in argv', () => {
    const row = parsePsArgsLine('999 100 00:05 opencode --session ses_abc', NOW)
    expect(row?.argv).toEqual(['opencode', '--session', 'ses_abc'])
  })

  it('drops header-shaped and truncated rows', () => {
    expect(parsePsArgsLine('PID PPID ELAPSED COMMAND', NOW)).toBeNull()
    expect(parsePsArgsLine('1 0', NOW)).toBeNull()
    expect(parsePsArgsLine('', NOW)).toBeNull()
  })
})

describe('parseCimArgsLine', () => {
  it('parses ticks and command line', () => {
    // 2026-09-18T18:28:40Z in .NET ticks.
    const row = parseCimArgsLine('23487\t22618\t639253529200000000\topencode --session ses_1')
    expect(row?.pid).toBe(23487)
    expect(row?.ppid).toBe(22618)
    expect(row?.startedAtMs).toBe(Date.parse('2026-09-18T18:28:40Z'))
    expect(row?.argv).toEqual(['opencode', '--session', 'ses_1'])
  })

  it('drops rows without a command line', () => {
    expect(parseCimArgsLine('4\t0\t639254819200000000\t')).toBeNull()
    expect(parseCimArgsLine('not-a-row')).toBeNull()
  })
})

describe('isOpenCodeClientArgv', () => {
  it('matches clients and rejects the serve daemon', () => {
    expect(isOpenCodeClientArgv(['opencode'])).toBe(true)
    expect(isOpenCodeClientArgv(['/opt/homebrew/bin/opencode', '--session', 'ses_1'])).toBe(true)
    expect(isOpenCodeClientArgv(['C:\\tools\\opencode.exe'])).toBe(true)
    expect(isOpenCodeClientArgv(['opencode.exe', 'serve', '--service'])).toBe(false)
    expect(isOpenCodeClientArgv(['node', 'server.js'])).toBe(false)
    expect(isOpenCodeClientArgv([])).toBe(false)
  })
})
