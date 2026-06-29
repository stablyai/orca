import { describe, expect, it } from 'vitest'
import { formatLogcat } from './emulator-logcat-format'

describe('formatLogcat', () => {
  it('ignores malformed rows instead of throwing', () => {
    expect(
      formatLogcat([
        null,
        42,
        {
          timestamp: '10-01 12:00:00.000',
          level: 'I',
          tag: 'Main',
          message: 'ready'
        }
      ])
    ).toBe('10-01 12:00:00.000 I Main: ready')
  })
})
