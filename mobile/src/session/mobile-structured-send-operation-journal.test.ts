import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../src/shared/agent-session-host-authority'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  reconcileMobileStructuredSendOperations,
  resetMobileStructuredSendOperationJournalForTests
} from './mobile-structured-send-operation-journal'
import { readMirroredStorage } from '../storage/mirrored-storage-keys'

const NOW = 1_900_000_000_000
/** The key older builds wrote, which the hybrid shell mirrors into every `init`. */
const JOURNAL_KEY = 'orca:mobileStructuredSendOperations:v1'

function operationIdAt(timestamp: number, entropy: string): string {
  return `${timestamp}-${entropy.repeat(32).slice(0, 32)}`
}

function entry(operationId: string, fill: string, payloadFingerprint = 'b'.repeat(64)) {
  return {
    operationKey: fill.repeat(64),
    operationId,
    callerFingerprint: 'c'.repeat(64),
    payloadFingerprint,
    attachmentPaths: []
  }
}

function journal(entries: readonly ReturnType<typeof entry>[]): string {
  return JSON.stringify({ v: 1, entries })
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  payloadFingerprint = 'b'.repeat(64)
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: NOW,
    resolvedAt: NOW
  }
}

describe('mobile structured send operation journal', () => {
  let values: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    values = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => values.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      values.delete(key)
    })
  })

  it('clears only the exact settled operation', async () => {
    const settledId = operationIdAt(NOW, '1')
    const kept = entry(operationIdAt(NOW, '2'), 'e')
    values.set(JOURNAL_KEY, journal([entry(settledId, 'd'), kept]))

    await reconcileMobileStructuredSendOperations({
      submissions: [
        submission(settledId, 'accepted'),
        submission(kept.operationId, 'accepted', 'f'.repeat(64))
      ],
      now: NOW
    })

    expect(values.get(JOURNAL_KEY)).toBe(journal([kept]))
  })

  it('keeps an entry whose submission is not settled yet', async () => {
    const operationId = operationIdAt(NOW, '3')
    const held = journal([entry(operationId, 'd')])
    values.set(JOURNAL_KEY, held)

    await reconcileMobileStructuredSendOperations({
      submissions: [submission(operationId, 'unknown'), submission(operationId, 'pending')],
      now: NOW
    })

    expect(values.get(JOURNAL_KEY)).toBe(held)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('prunes entries past the host replay window and keeps younger ones', async () => {
    const atTheEdge = entry(
      operationIdAt(NOW - AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS, '4'),
      'd'
    )
    const expired = entry(
      operationIdAt(NOW - AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS - 1, '5'),
      'e'
    )
    const young = entry(operationIdAt(NOW - 1, '6'), 'f')
    values.set(JOURNAL_KEY, journal([atTheEdge, expired, young]))

    await reconcileMobileStructuredSendOperations({ submissions: [], now: NOW })

    expect(values.get(JOURNAL_KEY)).toBe(journal([atTheEdge, young]))
  })

  it('removes the key once the last entry goes', async () => {
    const operationId = operationIdAt(NOW, '7')
    values.set(JOURNAL_KEY, journal([entry(operationId, 'd')]))

    await reconcileMobileStructuredSendOperations({
      submissions: [submission(operationId, 'rejected')],
      now: NOW
    })

    expect(values.has(JOURNAL_KEY)).toBe(false)
    expect(asyncStorage.removeItem).toHaveBeenCalledWith(JOURNAL_KEY)
  })

  it('writes nothing when there is no journal', async () => {
    await reconcileMobileStructuredSendOperations({
      submissions: [submission(operationIdAt(NOW, '8'), 'accepted')],
      now: NOW
    })

    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })

  it('leaves an unreadable journal in place rather than wiping it', async () => {
    const unreadable = journal([entry('not-an-operation-id', 'd')])
    values.set(JOURNAL_KEY, unreadable)

    await expect(
      reconcileMobileStructuredSendOperations({ submissions: [], now: NOW })
    ).rejects.toThrow('unreadable')

    expect(values.get(JOURNAL_KEY)).toBe(unreadable)
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })

  /**
   * A mirror the page reads is not allowed to run ahead of the store (round 4, CodeRabbit).
   *
   * The hybrid shell builds `init` from the mirror synchronously, so keeping the note after the
   * persist was refused would hand the page a journal that does not exist.
   */
  it('rolls the mirror back when persisting the last clear fails', async () => {
    const first = operationIdAt(NOW, '9')
    const last = entry(operationIdAt(NOW, 'a'), 'e')
    values.set(JOURNAL_KEY, journal([entry(first, 'd'), last]))
    await reconcileMobileStructuredSendOperations({
      submissions: [submission(first, 'accepted')],
      now: NOW
    })
    const held = readMirroredStorage([JOURNAL_KEY])[JOURNAL_KEY]
    expect(held).toBe(journal([last]))
    asyncStorage.removeItem.mockRejectedValueOnce(new Error('the store is full'))

    await expect(
      reconcileMobileStructuredSendOperations({
        submissions: [submission(last.operationId, 'accepted')],
        now: NOW
      })
    ).rejects.toThrow('the store is full')

    expect(readMirroredStorage([JOURNAL_KEY])[JOURNAL_KEY]).toBe(held)
  })
})
