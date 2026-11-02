import { describe, expect, it } from 'vitest'
import { parseLogcatLine, type LogcatEntry } from './android-logcat'

describe('parseLogcatLine', () => {
  it('keeps colons that belong to the message', () => {
    expect(
      parseLogcatLine('06-26 12:00:00.123  1234  5678 E MyTag: value: 42')
    ).toEqual<LogcatEntry>({
      timestamp: '06-26 12:00:00.123',
      level: 'E',
      tag: 'MyTag',
      message: 'value: 42'
    })
  })

  it('falls back to the raw trimmed line when the shape does not match', () => {
    expect(parseLogcatLine('--------- beginning of main')).toEqual<LogcatEntry>({
      message: '--------- beginning of main'
    })
  })
})
