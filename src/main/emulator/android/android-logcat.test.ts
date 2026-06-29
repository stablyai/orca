import { describe, expect, it } from 'vitest'
import { logcatArgs, parseLogcatLine, type LogcatEntry } from './android-logcat'

describe('logcatArgs', () => {
  it('builds base streaming args with the threadtime format', () => {
    expect(logcatArgs('emulator-5554')).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'threadtime'
    ])
  })

  it('adds -d before the format when dump is true', () => {
    expect(logcatArgs('emulator-5554', { dump: true })).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-d',
      '-v',
      'threadtime'
    ])
  })

  it('adds -t with the stringified line count', () => {
    expect(logcatArgs('emulator-5554', { lines: 100 })).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'threadtime',
      '-t',
      '100'
    ])
  })

  it('appends filterspec tokens at the end', () => {
    expect(logcatArgs('emulator-5554', { filters: ['MyTag:D', '*:S'] })).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'threadtime',
      'MyTag:D',
      '*:S'
    ])
  })

  it('combines dump, lines, and filters in order', () => {
    expect(
      logcatArgs('emulator-5554', { dump: true, lines: 50, filters: ['MyTag:D', '*:S'] })
    ).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-d',
      '-v',
      'threadtime',
      '-t',
      '50',
      'MyTag:D',
      '*:S'
    ])
  })
})

describe('parseLogcatLine', () => {
  it('parses a well-formed threadtime-format line', () => {
    expect(
      parseLogcatLine('06-26 12:00:00.123  1234  5678 D MyTag: hello world')
    ).toEqual<LogcatEntry>({
      timestamp: '06-26 12:00:00.123',
      level: 'D',
      tag: 'MyTag',
      message: 'hello world'
    })
  })

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

  it('trims surrounding whitespace in the fallback', () => {
    expect(parseLogcatLine('   not a logcat line   ')).toEqual<LogcatEntry>({
      message: 'not a logcat line'
    })
  })
})
