import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentModelCatalogListingStoppedError,
  type AgentModelCatalogFailures
} from './agent-model-catalog-failures'
import {
  refreshAgentModelCatalogListing,
  type InFlightListing
} from './agent-model-catalog-lister'
import type { AgentModelCatalogListingWaiters } from './agent-model-catalog-listing-waiters'

type MockSpan = {
  name: string
  setAttribute: ReturnType<typeof vi.fn>
  addEvent: ReturnType<typeof vi.fn>
  fail: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const mockSpans: MockSpan[] = []

vi.mock('../../observability/tracer', () => ({
  startSpan: vi.fn((name: string) => {
    const span: MockSpan = {
      name,
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      end: vi.fn()
    }
    mockSpans.push(span)
    return span
  })
}))

describe('refreshAgentModelCatalogListing error handling', () => {
  beforeEach(() => {
    mockSpans.length = 0
    vi.clearAllMocks()
  })

  it('ends span cleanly without failure when listModels rejects with AgentModelCatalogListingStoppedError', async () => {
    const refreshes = new Map<string, InFlightListing>()
    const listingWaiters = { notify: vi.fn() } as unknown as AgentModelCatalogListingWaiters
    const failures: AgentModelCatalogFailures = {
      probeFailed: vi.fn(),
      read: vi.fn(),
      clear: vi.fn()
    } as unknown as AgentModelCatalogFailures
    const failed = vi.fn()
    const writeSuccess = vi.fn()
    const targetDue = vi.fn(() => false)
    const targetAttempted = vi.fn()

    let admissionReleased = false
    const admission = {
      acquire: vi.fn(async () => () => {
        admissionReleased = true
      })
    }

    const listModels = vi.fn().mockRejectedValue(
      new AgentModelCatalogListingStoppedError('Chat folder missing')
    )

    const flightPromise = refreshAgentModelCatalogListing({
      fingerprint: 'fp-stopped',
      agent: 'opencode',
      listModels,
      maxTargets: 5,
      targetDue,
      targetAttempted,
      budget: { admission },
      refreshes,
      failures,
      listingWaiters,
      failed,
      writeSuccess
    })

    const result = await flightPromise

    // 1. Result resolves cleanly to null
    expect(result).toBeNull()

    // 2. Span ended cleanly without marking failure
    expect(mockSpans).toHaveLength(1)
    const [span] = mockSpans
    expect(span.name).toBe('agentModelCatalog.discovery')
    expect(span.end).toHaveBeenCalledTimes(1)
    expect(span.fail).not.toHaveBeenCalled()

    // 3. No failure recorded in failures tracker or callback
    expect(failures.probeFailed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()

    // 4. Admission lock released and flight retired
    expect(admissionReleased).toBe(true)
    expect(refreshes.has('fp-stopped')).toBe(false)
  })

  it('marks span as failed and records probe failure on generic listing errors', async () => {
    const refreshes = new Map<string, InFlightListing>()
    const listingWaiters = { notify: vi.fn() } as unknown as AgentModelCatalogListingWaiters
    const failures: AgentModelCatalogFailures = {
      probeFailed: vi.fn(),
      read: vi.fn(),
      clear: vi.fn()
    } as unknown as AgentModelCatalogFailures
    const failed = vi.fn()
    const writeSuccess = vi.fn()
    const targetDue = vi.fn(() => false)
    const targetAttempted = vi.fn()

    let admissionReleased = false
    const admission = {
      acquire: vi.fn(async () => () => {
        admissionReleased = true
      })
    }

    const genericError = new Error('Connection timeout')
    const listModels = vi.fn().mockRejectedValue(genericError)

    const flightPromise = refreshAgentModelCatalogListing({
      fingerprint: 'fp-generic',
      agent: 'grok',
      listModels,
      maxTargets: 5,
      targetDue,
      targetAttempted,
      budget: { admission },
      refreshes,
      failures,
      listingWaiters,
      failed,
      writeSuccess
    })

    const result = await flightPromise
    expect(result).toBeNull()

    // 1. Span marked as failed
    expect(mockSpans).toHaveLength(1)
    const [span] = mockSpans
    expect(span.fail).toHaveBeenCalledWith(genericError)

    // 2. Failure recorded
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failures.probeFailed).toHaveBeenCalledWith('fp-generic', 'grok', genericError)

    // 3. Admission released and flight retired
    expect(admissionReleased).toBe(true)
    expect(refreshes.has('fp-generic')).toBe(false)
  })
})
