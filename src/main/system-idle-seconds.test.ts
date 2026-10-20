import { describe, expect, it } from 'vitest'
import { readSystemIdleSeconds } from './system-idle-seconds'

describe('readSystemIdleSeconds', () => {
  it('passes through a reported idle time', () => {
    expect(readSystemIdleSeconds({ getSystemIdleTime: () => 42 })).toBe(42)
    expect(readSystemIdleSeconds({ getSystemIdleTime: () => 0 })).toBe(0)
  })

  it('reports unknown rather than idle when the platform cannot measure it', () => {
    expect(readSystemIdleSeconds({ getSystemIdleTime: () => Number.NaN })).toBeNull()
    expect(readSystemIdleSeconds({ getSystemIdleTime: () => -1 })).toBeNull()
    expect(
      readSystemIdleSeconds({
        getSystemIdleTime: () => {
          throw new Error('unsupported session type')
        }
      })
    ).toBeNull()
  })
})
