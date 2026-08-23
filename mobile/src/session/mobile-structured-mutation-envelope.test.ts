import { describe, expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../src/shared/agent-session-mutation-envelope'
import {
  createMobileStructuredOperationId,
  mobileStructuredPayloadFingerprint
} from './mobile-structured-mutation-envelope'

describe('mobile structured mutation envelope', () => {
  it('matches the host fingerprint across nested property order and undefined fields', () => {
    const input = {
      method: 'agentSession.send',
      sessionId: 'mobile_1',
      fields: {
        body: {
          role: 'user',
          blocks: [{ text: 'hello', omitted: undefined, type: 'text' }],
          kind: 'message'
        }
      }
    }

    expect(mobileStructuredPayloadFingerprint(input)).toBe(
      computeAgentSessionPayloadFingerprint(input)
    )
  })

  it('mints durable host-compatible operation ids', () => {
    expect(
      createMobileStructuredOperationId(
        () => '00000000-0000-4000-8000-000000000001',
        1_700_000_000_000
      )
    ).toBe('1700000000000-00000000000040008000000000000001')
  })

  it('rejects entropy or timestamps the durable host cannot admit', () => {
    expect(() => createMobileStructuredOperationId(() => 'uuid', 1_700_000_000_000)).toThrow(
      'Unable to create a durable operation id'
    )
    expect(() =>
      createMobileStructuredOperationId(() => '00000000-0000-4000-8000-000000000001', 1_700_000_000)
    ).toThrow('Unable to create a durable operation id')
  })
})
