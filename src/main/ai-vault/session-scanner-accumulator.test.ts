import { describe, expect, it } from 'vitest'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'

describe('finalizeSession readOnly', () => {
  it('defaults readOnly to false and carries an explicit true through', () => {
    const base = {
      agent: 'claude' as const,
      file: { path: '/x', mtimeMs: 1, modifiedAt: 'z' },
      sessionId: 's'
    }
    const acc = createAccumulator(base)
    acc.messageCount = 1
    expect(finalizeSession(acc, 'darwin')?.readOnly).toBe(false)

    const acc2 = createAccumulator(base)
    acc2.messageCount = 1
    acc2.readOnly = true
    expect(finalizeSession(acc2, 'darwin')?.readOnly).toBe(true)
  })
})
