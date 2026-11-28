import { describe, expect, it } from 'vitest'
import { getDueDateFlag } from './linear-request-builders'

describe('getDueDateFlag', () => {
  it('refuses a day its month does not have', () => {
    expect(() => getDueDateFlag(new Map([['due-date', '2027-02-30']]), 'due-date')).toThrow(
      'must be a real calendar date'
    )
  })
})
