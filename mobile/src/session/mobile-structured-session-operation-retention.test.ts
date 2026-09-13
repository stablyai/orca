import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../src/shared/agent-session-host-authority'
import { retainStructuredSessionOperationId } from './mobile-structured-agent-session-rpc'

const NOW = 1_900_000_000_000

function operationIdAt(timestamp: number, entropy: string): string {
  return `${timestamp}-${entropy.repeat(32).slice(0, 32)}`
}

describe('structured session operation retention', () => {
  it('keeps every unconfirmed operation id past the old 128-entry cap', () => {
    const operationIds = new Map<string, string>()
    for (let index = 0; index < 400; index += 1) {
      retainStructuredSessionOperationId(
        operationIds,
        `request-${index}`,
        operationIdAt(NOW, 'a'),
        NOW
      )
    }

    expect(operationIds.size).toBe(400)
    // Why: the first send is exactly the one a retry would duplicate if it were evicted.
    expect(operationIds.get('request-0')).toBe(operationIdAt(NOW, 'a'))
  })

  it('releases only ids the host would already refuse as expired', () => {
    const operationIds = new Map<string, string>()
    const expired = operationIdAt(NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 1, 'b')
    const admissible = operationIdAt(NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS, 'c')
    retainStructuredSessionOperationId(operationIds, 'stale', expired, NOW)
    retainStructuredSessionOperationId(operationIds, 'live', admissible, NOW)

    retainStructuredSessionOperationId(operationIds, 'fresh', operationIdAt(NOW, 'd'), NOW)

    expect(operationIds.has('stale')).toBe(false)
    expect(operationIds.get('live')).toBe(admissible)
    expect(operationIds.get('fresh')).toBe(operationIdAt(NOW, 'd'))
  })

  it('drops ids the host could never admit and re-keys a repeated send', () => {
    const operationIds = new Map<string, string>()
    retainStructuredSessionOperationId(operationIds, 'unparseable', 'not-an-operation-id', NOW)
    const reused = retainStructuredSessionOperationId(
      operationIds,
      'send',
      operationIdAt(NOW, 'e'),
      NOW
    )

    // A retry of the same send reuses the retained id rather than minting a duplicate.
    expect(
      retainStructuredSessionOperationId(operationIds, 'send', operationIds.get('send'), NOW)
    ).toBe(reused)
    expect(operationIds.has('unparseable')).toBe(false)
  })
})
