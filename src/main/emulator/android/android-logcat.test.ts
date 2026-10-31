import { describe, expect, it } from 'vitest'
import { parseLogcatLine, type LogcatEntry } from './android-logcat'

describe('parseLogcatLine', () => {
  it('keeps colons that belong to the message', () => {
    expect(
      parseLogcatLine('06-26 12:00:00.123  1234  5678 E MyTag: value: 42')
    ).toEqual<LogcatEntry>({
      timestamp: '06-26 12:00:00.123',
      pid: 1234,
      tid: 5678,
      level: 'E',
      tag: 'MyTag',
      message: 'value: 42'
    })
  })

  it('preserves zero identifiers with variable whitespace', () => {
    expect(parseLogcatLine(' 06-26 12:00:00.123\t0  0\tI MyTag  : value: 0 ')).toEqual<LogcatEntry>(
      {
        timestamp: '06-26 12:00:00.123',
        pid: 0,
        tid: 0,
        level: 'I',
        tag: 'MyTag',
        message: 'value: 0'
      }
    )
  })

  it.each([
    '--------- beginning of main',
    '06-26 12:00:00.123 1234 missing E MyTag: value: 42',
    '06-26 12:00:00.123 1234 5678 E MyTag'
  ])('falls back to the raw trimmed line when the shape does not match: %s', (line) => {
    expect(parseLogcatLine(` ${line} `)).toEqual<LogcatEntry>({
      message: line
    })
  })
})
