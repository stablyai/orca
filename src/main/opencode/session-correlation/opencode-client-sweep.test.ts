import { describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  isOpenCodeClientArgv,
  isOpenCodeClientProcess,
  parsePsArgsLine,
  parsePsCommLine,
  parsePsElapsedToMs,
  sweepProcessIdentities
} from './opencode-client-sweep'

const NOW = 1_700_000_000_000

describe('parsePsElapsedToMs', () => {
  it('reads mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parsePsElapsedToMs('02:11', NOW)).toBe(NOW - 131_000)
    expect(parsePsElapsedToMs('1:02:11', NOW)).toBe(NOW - 3_731_000)
    expect(parsePsElapsedToMs('2-01:02:11', NOW)).toBe(NOW - 176_531_000)
  })
})

describe('parsePsArgsLine', () => {
  it('keeps a quoted executable path as argv[0]', () => {
    const row = parsePsArgsLine('999 100 00:05 "/opt/my tools/opencode" --session ses_abc', NOW)
    expect(row?.argv).toEqual(['/opt/my tools/opencode', '--session', 'ses_abc'])
    expect(row?.executable).toBe('')
  })
})

describe('parsePsCommLine', () => {
  it('keeps executable names containing spaces whole', () => {
    expect(parsePsCommLine('  999  My App Helper ')).toEqual({
      pid: 999,
      executable: 'My App Helper'
    })
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
})

describe('sweepProcessIdentities', () => {
  function psRunner(
    outputs: Record<'args' | 'comm', string | Error>
  ): (spec: ProcessSpec) => Promise<ProcessResult> {
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
})
