import { describe, expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'

describe('orchestration attention notification options', () => {
  it('renders the persisted gate question', () => {
    expect(
      buildNotificationOptions({
        source: 'orchestration-attention',
        gateId: 'gate_1',
        question: 'Proceed with the migration?'
      })
    ).toEqual({
      title: 'Agent needs a decision',
      body: 'Proceed with the migration?'
    })
  })
})
