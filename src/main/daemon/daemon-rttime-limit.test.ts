import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  realtimeTimeoutLimitFromProcLimits,
  warnWhenRealtimeTimeoutIsZero
} from './daemon-rttime-limit'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function limitsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-limits-'))
  dirs.push(dir)
  const path = join(dir, 'limits')
  writeFileSync(path, contents)
  return path
}

function procLimits(soft: string, hard: string): string {
  return [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    'Max realtime priority     0                    0                    ',
    `Max realtime timeout      ${soft.padEnd(21)}${hard.padEnd(21)}us        `,
    ''
  ].join('\n')
}

describe('realtimeTimeoutLimitFromProcLimits', () => {
  it.each([
    ['0', '0'],
    ['200000', '200000'],
    ['unlimited', 'unlimited']
  ])('reads soft %s and hard %s', (soft, hard) => {
    expect(realtimeTimeoutLimitFromProcLimits(procLimits(soft, hard))).toEqual({ soft, hard })
  })

  it('is null without a realtime timeout line', () => {
    expect(
      realtimeTimeoutLimitFromProcLimits('Max cpu time  unlimited  unlimited  seconds\n')
    ).toBe(null)
  })
})

describe('warnWhenRealtimeTimeoutIsZero', () => {
  it('logs the limit and the remedy when the hard limit is zero', () => {
    const log = vi.fn()
    expect(
      warnWhenRealtimeTimeoutIsZero(log, {
        platform: 'linux',
        limitsPath: limitsFile(procLimits('0', '0'))
      })
    ).toBe(true)
    expect(log).toHaveBeenCalledWith('rttime-limit-zero', {
      soft: '0',
      hard: '0',
      hint: expect.stringContaining('RealtimeKit')
    })
  })

  it.each([
    ['unlimited', 'unlimited'],
    ['200000', '200000'],
    ['0', '200000']
  ])('stays quiet for soft %s and hard %s', (soft, hard) => {
    const log = vi.fn()
    expect(
      warnWhenRealtimeTimeoutIsZero(log, {
        platform: 'linux',
        limitsPath: limitsFile(procLimits(soft, hard))
      })
    ).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('stays quiet when the limits file is unreadable', () => {
    const log = vi.fn()
    expect(
      warnWhenRealtimeTimeoutIsZero(log, { platform: 'linux', limitsPath: '/definitely/missing' })
    ).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32'] as const)('skips %s without reading anything', (platform) => {
    const log = vi.fn()
    expect(
      warnWhenRealtimeTimeoutIsZero(log, {
        platform,
        limitsPath: limitsFile(procLimits('0', '0'))
      })
    ).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })
})
