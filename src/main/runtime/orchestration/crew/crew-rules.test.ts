import { describe, expect, it } from 'vitest'
import { crewRowStatus } from './crew-rules'

describe('crew row status', () => {
  it('keeps an open dispatch idle when the agent last reported done, and done only after it settles', () => {
    expect(crewRowStatus('done', 'dispatched')).toBe('idle')
    expect(crewRowStatus('working', 'dispatched')).toBe('working')
    expect(crewRowStatus('done', 'completed')).toBe('done')
    expect(crewRowStatus(undefined, 'pending')).toBe('idle')
    expect(crewRowStatus(undefined, undefined)).toBe('unknown')
  })
})
