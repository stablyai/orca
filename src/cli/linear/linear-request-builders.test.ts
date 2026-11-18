import { describe, expect, it } from 'vitest'
import { getPriorityFlag } from './linear-request-builders'

// The CLI's priority names before they came from priority-label.ts.
const BEFORE = new Map([
  ['none', 0],
  ['urgent', 1],
  ['high', 2],
  ['medium', 3],
  ['low', 4]
])

function parsePriority(value: string): number | string {
  try {
    return getPriorityFlag(new Map([['to', value]]), 'to')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('getPriorityFlag', () => {
  it.each([
    'none',
    'urgent',
    'high',
    'medium',
    'low',
    'URGENT',
    'High',
    'No priority',
    ' high',
    '1',
    'urgentt'
  ])('reads %j as before', (value) => {
    expect(parsePriority(value)).toBe(
      BEFORE.get(value.toLowerCase()) ?? '--to must be none, low, medium, high, or urgent'
    )
  })
})
