import { describe, expect, it } from 'vitest'
import { GoogleToolError } from './google-api-client'
import { parseEventTime } from './google-event-time'
import { windowBound } from './google-time-zone'

const ZONE = 'Asia/Shanghai'

describe('parseEventTime', () => {
  it('refuses a day its month does not have instead of rolling it into the next month', () => {
    for (const value of [
      '2027-02-30',
      '2027-02-30T10:00',
      '2026-02-29 09:00',
      '2027-04-31T10:00Z'
    ]) {
      expect(() => parseEventTime(value, ZONE, '--start')).toThrow(GoogleToolError)
    }
    expect(parseEventTime('2028-02-29T10:00', ZONE, '--start')).toEqual({
      kind: 'time',
      ms: Date.parse('2028-02-29T02:00:00Z')
    })
  })

  it('answers an impossible clock time with the usage instead of an internal error', () => {
    for (const value of ['2027-03-05T10:60', '2027-03-05 25:00']) {
      expect(() => parseEventTime(value, ZONE, '--start')).toThrow(GoogleToolError)
    }
    expect(parseEventTime('2027-03-05T24:00', ZONE, '--start')).toEqual({
      kind: 'time',
      ms: Date.parse('2027-03-05T16:00:00Z')
    })
  })
})

describe('windowBound', () => {
  it('refuses a day its month does not have', () => {
    expect(windowBound('2027-02-30', ZONE, false)).toBeNull()
    expect(windowBound('2027-02-28', ZONE, false)).toBe('2027-02-28T00:00:00+08:00')
  })
})
