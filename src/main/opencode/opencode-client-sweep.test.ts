import { describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'
import {
  isOpenCodeClientArgv,
  isOpenCodeClientProcess,
  nativeWindowsRowToIdentity,
  parsePsArgsLine,
  parsePsCommLine,
  parsePsElapsedToMs,
  splitCommandLineArgv,
  sweepProcessIdentities
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

  it('keeps a quoted executable path as argv[0]', () => {
    const row = parsePsArgsLine('999 100 00:05 "/opt/my tools/opencode" --session ses_abc', NOW)
    expect(row?.argv).toEqual(['/opt/my tools/opencode', '--session', 'ses_abc'])
    expect(row?.executable).toBe('')
  })

  it('drops header-shaped and truncated rows', () => {
    expect(parsePsArgsLine('PID PPID ELAPSED COMMAND', NOW)).toBeNull()
    expect(parsePsArgsLine('1 0', NOW)).toBeNull()
    expect(parsePsArgsLine('', NOW)).toBeNull()
  })
})

describe('parsePsCommLine', () => {
  it('reads the executable name past the pid', () => {
    expect(parsePsCommLine('23487 opencode')).toEqual({ pid: 23487, executable: 'opencode' })
  })

  it('keeps executable names containing spaces whole', () => {
    expect(parsePsCommLine('  999  My App Helper ')).toEqual({
      pid: 999,
      executable: 'My App Helper'
    })
  })

  it('drops header-shaped and truncated rows', () => {
    expect(parsePsCommLine('PID COMMAND')).toBeNull()
    expect(parsePsCommLine('1')).toBeNull()
    expect(parsePsCommLine('')).toBeNull()
  })
})

describe('splitCommandLineArgv', () => {
  it('groups double-quoted spans', () => {
    expect(
      splitCommandLineArgv('"C:\\Program Files\\OpenCode\\opencode.exe" --session ses_1')
    ).toEqual(['C:\\Program Files\\OpenCode\\opencode.exe', '--session', 'ses_1'])
  })

  it('splits plain argv on whitespace', () => {
    expect(splitCommandLineArgv('opencode --session ses_1')).toEqual([
      'opencode',
      '--session',
      'ses_1'
    ])
  })

  it('drops empties', () => {
    expect(splitCommandLineArgv('')).toEqual([])
  })
})

describe('nativeWindowsRowToIdentity', () => {
  it('maps pid, creation time and quoted command line', () => {
    const row = nativeWindowsRowToIdentity({
      pid: 23487,
      ppid: 22618,
      name: 'opencode.exe',
      creationTimeMs: NOW - 60_000,
      command: '"C:\\Program Files\\OpenCode\\opencode.exe" --session ses_1'
    })
    expect(row).toMatchObject({
      pid: 23487,
      ppid: 22618,
      startedAtMs: NOW - 60_000,
      executable: 'opencode.exe',
      argv: ['C:\\Program Files\\OpenCode\\opencode.exe', '--session', 'ses_1']
    })
  })

  it('skips rows without a creation time or command line', () => {
    expect(nativeWindowsRowToIdentity({ pid: 4, ppid: 0, name: 'System', command: '' })).toBeNull()
    expect(
      nativeWindowsRowToIdentity({ pid: 4, ppid: 0, name: 'System', command: 'opencode' })
    ).toBeNull()
  })
})

describe('isOpenCodeClientArgv', () => {
  it('matches clients and rejects the serve daemon', () => {
    expect(isOpenCodeClientArgv(['opencode'])).toBe(true)
    expect(isOpenCodeClientArgv(['/opt/homebrew/bin/opencode', '--session', 'ses_1'])).toBe(true)
    expect(isOpenCodeClientArgv(['C:\\tools\\opencode.exe'])).toBe(true)
    expect(
      isOpenCodeClientArgv(['C:\\Program Files\\OpenCode\\opencode.exe', '--session', 'ses_1'])
    ).toBe(true)
    expect(isOpenCodeClientArgv(['opencode.exe', 'serve', '--service'])).toBe(false)
    expect(isOpenCodeClientArgv(['node', 'server.js'])).toBe(false)
    expect(isOpenCodeClientArgv([])).toBe(false)
  })
})

describe('isOpenCodeClientProcess', () => {
  it('trusts the executable when argv[0] is truncated by spaces', () => {
    expect(
      isOpenCodeClientProcess({ executable: 'opencode', argv: ['/opt/Open', 'Code/opencode'] })
    ).toBe(true)
  })

  it('still rejects the serve daemon', () => {
    expect(
      isOpenCodeClientProcess({ executable: 'opencode', argv: ['opencode', 'serve', '--service'] })
    ).toBe(false)
  })

  it('falls back to argv[0] without an executable', () => {
    expect(isOpenCodeClientProcess({ executable: '', argv: ['opencode'] })).toBe(true)
    expect(isOpenCodeClientProcess({ executable: '', argv: ['node', 'server.js'] })).toBe(false)
  })
})

describe('sweepProcessIdentities', () => {
  function psRunner(outputs: Record<'args' | 'comm', string | Error>): (
    spec: ProcessSpec
  ) => Promise<ProcessResult> {
    return async (spec: ProcessSpec): Promise<ProcessResult> => {
      const kind = spec.args?.some((arg) => arg.includes('comm=')) ? 'comm' : 'args'
      const output = outputs[kind]
      if (output instanceof Error) {
        throw output
      }
      return {
        code: 0,
        signal: null,
        stdout: output,
        stderr: '',
        timedOut: false
      }
    }
  }

  it('joins the comm executable onto args rows on POSIX', async () => {
    const rows = await sweepProcessIdentities({
      platform: 'darwin',
      nowMs: NOW,
      run: psRunner({
        args: '23487 22618 00:05 /opt/Open Code/opencode --session ses_1\n',
        comm: '23487 opencode\n999 My App Helper\n'
      })
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 23487, executable: 'opencode' })
    expect(rows[0]?.argv).toEqual(['/opt/Open', 'Code/opencode', '--session', 'ses_1'])
  })

  it('degrades to argv[0] matching when the comm sweep fails', async () => {
    const rows = await sweepProcessIdentities({
      platform: 'darwin',
      nowMs: NOW,
      run: psRunner({
        args: '23487 22618 00:05 opencode --session ses_1\n',
        comm: new Error('comm unavailable')
      })
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 23487, executable: '' })
  })

  it('reads the Windows table through the injected reader', async () => {
    const rows = await sweepProcessIdentities({
      platform: 'win32',
      readWindowsTable: async () => [
        {
          pid: 23487,
          ppid: 22618,
          name: 'opencode.exe',
          creationTimeMs: NOW - 60_000,
          command: '"C:\\Program Files\\OpenCode\\opencode.exe"'
        }
      ]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 23487, ppid: 22618, startedAtMs: NOW - 60_000 })
  })
})
