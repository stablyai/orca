import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RELAY_AI_VAULT_USAGE_SCAN_TIMEOUT_MS,
  armRelayAiVaultCallTimeout,
  createRelayAiVaultServiceCall
} from './ai-vault-service-client-state'

describe('armRelayAiVaultCallTimeout for usage scans', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives a cold Claude usage scan the long deadline on the cache lane', () => {
    const call = createRelayAiVaultServiceCall({
      request: { type: 'request', id: 1, operation: 'claudeUsage', params: { worktrees: [] } },
      resolve: vi.fn(),
      reject: vi.fn()
    })
    const onExpired = vi.fn()

    armRelayAiVaultCallTimeout(call, onExpired)
    vi.advanceTimersByTime(RELAY_AI_VAULT_USAGE_SCAN_TIMEOUT_MS - 1)
    const firedEarly = onExpired.mock.calls.length
    vi.advanceTimersByTime(1)

    expect(call.lane).toBe('cache')
    expect(firedEarly).toBe(0)
    expect(onExpired).toHaveBeenCalledWith(RELAY_AI_VAULT_USAGE_SCAN_TIMEOUT_MS)
  })
})
