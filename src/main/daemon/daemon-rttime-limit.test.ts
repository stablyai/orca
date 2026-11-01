import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { warnWhenRealtimeTimeoutIsZero } from './daemon-rttime-limit'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function procLimits(soft: string, hard: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-limits-'))
  dirs.push(dir)
  const path = join(dir, 'limits')
  writeFileSync(
    path,
    [
      'Limit                     Soft Limit           Hard Limit           Units     ',
      'Max realtime priority     0                    0                    ',
      `Max realtime timeout      ${soft.padEnd(21)}${hard.padEnd(21)}us        `,
      ''
    ].join('\n')
  )
  return path
}

describe('warnWhenRealtimeTimeoutIsZero', () => {
  it.each([
    ['0', '0'],
    ['0', '200000']
  ])('warns with a remedy hint for soft %s and hard %s', (soft, hard) => {
    const log = vi.fn()
    warnWhenRealtimeTimeoutIsZero(log, 'linux', procLimits(soft, hard))
    expect(log).toHaveBeenCalledWith('rttime-limit-zero', {
      soft,
      hard,
      hint: expect.stringContaining('RealtimeKit')
    })
  })

  it.each([
    ['unlimited', 'unlimited'],
    ['200000', '200000']
  ])('stays quiet for soft %s and hard %s', (soft, hard) => {
    const log = vi.fn()
    warnWhenRealtimeTimeoutIsZero(log, 'linux', procLimits(soft, hard))
    expect(log).not.toHaveBeenCalled()
  })

  it('stays quiet when the limits file is unreadable or off Linux', () => {
    const log = vi.fn()
    warnWhenRealtimeTimeoutIsZero(log, 'linux', '/definitely/missing')
    warnWhenRealtimeTimeoutIsZero(log, 'darwin', procLimits('0', '0'))
    warnWhenRealtimeTimeoutIsZero(log, 'win32', procLimits('0', '0'))
    expect(log).not.toHaveBeenCalled()
  })
})
