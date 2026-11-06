import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowsRealtimePriority, readZeroRtTimeLimit } from './linux-rttime-limit'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-rttime-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function limitsFile(rtPrio: [string, string], rtTime: [string, string]): string {
  const path = join(dir, 'limits')
  writeFileSync(
    path,
    [
      'Limit                     Soft Limit           Hard Limit           Units     ',
      `Max realtime priority     ${rtPrio[0].padEnd(21)}${rtPrio[1].padEnd(21)}`,
      `Max realtime timeout      ${rtTime[0].padEnd(21)}${rtTime[1].padEnd(21)}us        `,
      ''
    ].join('\n')
  )
  return path
}

describe('readZeroRtTimeLimit', () => {
  it.each([
    [['0', '0'], { soft: '0', hard: '0' }],
    [['0', 'unlimited'], { soft: '0', hard: 'unlimited' }],
    [['200000', '0'], { soft: '200000', hard: '0' }],
    [['unlimited', 'unlimited'], null],
    [['200000', '200000'], null]
  ] as const)('reads %j as %j', (rtTime, expected) => {
    expect(readZeroRtTimeLimit('linux', limitsFile(['0', '0'], [...rtTime]))).toEqual(expected)
  })

  it('returns null off Linux, for an unreadable file, or without the limit line', () => {
    const path = limitsFile(['0', '0'], ['0', '0'])
    expect(readZeroRtTimeLimit('darwin', path)).toBeNull()
    expect(readZeroRtTimeLimit('linux', join(dir, 'missing'))).toBeNull()
    writeFileSync(path, 'Limit Soft Limit Hard Limit Units\n')
    expect(readZeroRtTimeLimit('linux', path)).toBeNull()
  })
})

describe('allowsRealtimePriority', () => {
  it.each([
    [['0', '0'], false],
    [['0', '95'], true],
    [['95', '95'], true]
  ] as const)('treats RTPRIO %j as %s', (rtPrio, expected) => {
    expect(allowsRealtimePriority('linux', limitsFile([...rtPrio], ['0', '0']))).toBe(expected)
  })

  it('is false off Linux or when the limits cannot be read', () => {
    expect(allowsRealtimePriority('darwin', limitsFile(['95', '95'], ['0', '0']))).toBe(false)
    expect(allowsRealtimePriority('linux', join(dir, 'missing'))).toBe(false)
  })
})
