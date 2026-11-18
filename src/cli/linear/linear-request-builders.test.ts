import { describe, expect, it } from 'vitest'
import { getPriorityFlag } from './linear-request-builders'

const INVALID_PRIORITY = '--to must be none, low, medium, high, or urgent'

function parsePriority(value: string): number | string {
  try {
    return getPriorityFlag(new Map([['to', value]]), 'to')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('getPriorityFlag', () => {
  it.each([
    ['none', 0],
    ['URGENT', 1],
    ['No priority', INVALID_PRIORITY],
    [' high', INVALID_PRIORITY]
  ] as const)('reads priority flag %j', (value, expected) => {
    expect(parsePriority(value)).toBe(expected)
  })
})
