import { describe, expect, it } from 'vitest'
import { getOnceFlags } from './automation-once-flag'

function onceBy(by: string): ReturnType<typeof getOnceFlags> {
  return getOnceFlags(
    new Map<string, string | boolean>([
      ['once', true],
      ['by', by]
    ])
  )
}

describe('getOnceFlags --by', () => {
  it('refuses a day its month does not have instead of rolling it into the next month', () => {
    for (const by of [
      '2101-02-29T09:00:00+09:00',
      '2101-02-30T09:00:00+09:00',
      '2100-02-29T09:00:00Z',
      '2101-04-31 09:00'
    ]) {
      expect(() => onceBy(by)).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    }
    expect(onceBy('2104-02-29T09:00:00+09:00')).toEqual({ by: Date.UTC(2104, 1, 29) })
  })
})
