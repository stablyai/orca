import { describe, expect, it } from 'vitest'
import { scheduledFor } from './slack-action-args'

describe('scheduledFor', () => {
  it('refuses a day its month does not have', () => {
    expect(() => scheduledFor('2027-11-31T09:00Z', Date.UTC(2027, 10, 1))).toThrow(/--at takes/)
  })
})
