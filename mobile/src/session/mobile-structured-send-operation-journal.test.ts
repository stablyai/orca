import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../src/shared/agent-session-host-authority'
import { AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT } from '../../../src/shared/agent-session-operation-ledger'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  clearMobileStructuredSendOperation,
  clearMobileStructuredSettledSendOperations,
  getOrCreateMobileStructuredSendOperation as getOrCreatePersistedOperation,
  mobileStructuredSendCallerFingerprint,
  mobileStructuredSendOperationKey,
  resetMobileStructuredSendOperationJournalForTests
} from './mobile-structured-send-operation-journal'

const NOW = 1_900_000_000_000
const OPERATION_KEY = 'a'.repeat(64)
const CALLER_IDENTITY = 'mobile-device-a'

function getOrCreateMobileStructuredSendOperation(
  input: Omit<
    Parameters<typeof getOrCreatePersistedOperation>[0],
    'callerIdentity' | 'payloadFingerprint' | 'attachmentPaths'
  > & { payloadFingerprint?: string; attachmentPaths?: readonly string[] }
) {
  const { payloadFingerprint = 'b'.repeat(64), attachmentPaths = [], ...operation } = input
  return getOrCreatePersistedOperation({
    ...operation,
    callerIdentity: CALLER_IDENTITY,
    payloadFingerprint,
    attachmentPaths
  }).then(({ operationId, retained }) => ({ operationId, retained }))
}

function operationIdAt(timestamp: number, entropy: string): string {
  return `${timestamp}-${entropy.repeat(32).slice(0, 32)}`
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

  it('persists an ambiguous id before dispatch and reuses it after remount', async () => {
    const firstId = operationIdAt(NOW, '1')
    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => firstId,
        now: NOW
      })
    ).resolves.toEqual({ operationId: firstId, retained: false })

    resetMobileStructuredSendOperationJournalForTests()
    const createAfterRemount = vi.fn(() => operationIdAt(NOW, '2'))
    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: createAfterRemount,
        now: NOW
      })
    ).resolves.toEqual({ operationId: firstId, retained: true })
    expect(createAfterRemount).not.toHaveBeenCalled()
  })

  it('clears only the exact settled operation', async () => {
    const firstId = operationIdAt(NOW, '3')
    await getOrCreateMobileStructuredSendOperation({
      operationKey: OPERATION_KEY,
      createOperationId: () => firstId,
      now: NOW
    })

    await expect(
      clearMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        operationId: operationIdAt(NOW, '4')
      })
    ).rejects.toThrow('identity changed')
    await clearMobileStructuredSendOperation({
      operationKey: OPERATION_KEY,
      operationId: firstId
    })

    const secondId = operationIdAt(NOW, '5')
    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => secondId,
        now: NOW
      })
    ).resolves.toEqual({ operationId: secondId, retained: false })
  })

  it('clears an ack-lost id only when its journal submission settles', async () => {
    const sessionKey = 'host-a:session-a'
    const payloadFingerprint = 'c'.repeat(64)
    const operationKey = mobileStructuredSendOperationKey({
      sessionKey,
      intentFingerprint: payloadFingerprint
    })
    const operationId = operationIdAt(NOW, 'd')
    await getOrCreateMobileStructuredSendOperation({
      operationKey,
      payloadFingerprint,
      createOperationId: () => operationId,
      now: NOW
    })
    const submission = {
      clientMessageId: operationId,
      fence: 1,
      payloadFingerprint,
      dispatchState: 'unknown' as const,
      providerItemId: null,
      reason: 'ack lost',
      submittedAt: NOW,
      resolvedAt: NOW
    }

    await clearMobileStructuredSettledSendOperations({ submissions: [submission] })
    expect(values.size).toBe(1)

    await clearMobileStructuredSettledSendOperations({
      submissions: [{ ...submission, dispatchState: 'accepted', reason: null }]
    })
    expect(values.size).toBe(0)
  })

  it('does not clear a newer id for an older matching-payload submission', async () => {
    const sessionKey = 'host-a:session-a'
    const payloadFingerprint = 'e'.repeat(64)
    const operationKey = mobileStructuredSendOperationKey({
      sessionKey,
      intentFingerprint: payloadFingerprint
    })
    const operationId = operationIdAt(NOW, 'f')
    await getOrCreateMobileStructuredSendOperation({
      operationKey,
      payloadFingerprint,
      createOperationId: () => operationId,
      now: NOW
    })

    await clearMobileStructuredSettledSendOperations({
      submissions: [
        {
          clientMessageId: operationIdAt(NOW - 1, '1'),
          fence: 1,
          payloadFingerprint,
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: NOW - 1,
          resolvedAt: NOW - 1
        }
      ]
    })

    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey,
        createOperationId: () => operationIdAt(NOW, '2'),
        now: NOW
      })
    ).resolves.toEqual({ operationId, retained: true })
  })

  it('reuses the original attachment paths for an ambiguous repeat upload', async () => {
    const operationId = operationIdAt(NOW, 'e')
    const payloadFingerprint = 'd'.repeat(64)
    await getOrCreatePersistedOperation({
      operationKey: OPERATION_KEY,
      callerIdentity: CALLER_IDENTITY,
      payloadFingerprint,
      attachmentPaths: ['/tmp/original.png'],
      createOperationId: () => operationId,
      now: NOW
    })

    await expect(
      getOrCreatePersistedOperation({
        operationKey: OPERATION_KEY,
        callerIdentity: CALLER_IDENTITY,
        payloadFingerprint: 'e'.repeat(64),
        attachmentPaths: ['/tmp/reuploaded.png'],
        createOperationId: () => operationIdAt(NOW, 'f'),
        now: NOW
      })
    ).resolves.toEqual({
      operationId,
      retained: true,
      payloadFingerprint,
      attachmentPaths: ['/tmp/original.png']
    })
  })

  it('keeps an ambiguous id after the host replay window closes', async () => {
    const expired = operationIdAt(NOW - AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS - 1, '6')
    asyncStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        v: 1,
        entries: [
          {
            operationKey: OPERATION_KEY,
            operationId: expired,
            callerFingerprint: mobileStructuredSendCallerFingerprint(CALLER_IDENTITY),
            payloadFingerprint: 'b'.repeat(64),
            attachmentPaths: []
          }
        ]
      })
    )

    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => operationIdAt(NOW, '7'),
        now: NOW
      })
    ).resolves.toEqual({ operationId: expired, retained: true })
  })

  it('fails closed when a retained operation id is malformed', async () => {
    asyncStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        v: 1,
        entries: [
          {
            operationKey: OPERATION_KEY,
            operationId: 'not-an-operation-id',
            callerFingerprint: mobileStructuredSendCallerFingerprint(CALLER_IDENTITY),
            payloadFingerprint: 'b'.repeat(64),
            attachmentPaths: []
          }
        ]
      })
    )

    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => operationIdAt(NOW, '8'),
        now: NOW
      })
    ).rejects.toThrow('unreadable')
  })

  it('fails closed when durable identity cannot be read or written', async () => {
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => operationIdAt(NOW, '9'),
        now: NOW
      })
    ).rejects.toThrow('storage unavailable')

    asyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => operationIdAt(NOW, 'a'),
        now: NOW
      })
    ).rejects.toThrow('disk full')
    expect(values.size).toBe(0)
  })

  it('refuses new sends rather than evicting an ambiguous id at capacity', async () => {
    asyncStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        v: 1,
        entries: Array.from(
          { length: AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT },
          (_, index) => ({
            operationKey: index.toString(16).padStart(64, '0'),
            operationId: operationIdAt(NOW, index.toString(16).padStart(32, '0')),
            callerFingerprint: mobileStructuredSendCallerFingerprint(CALLER_IDENTITY),
            payloadFingerprint: 'b'.repeat(64),
            attachmentPaths: []
          })
        )
      })
    )

    await expect(
      getOrCreateMobileStructuredSendOperation({
        operationKey: OPERATION_KEY,
        createOperationId: () => operationIdAt(NOW, 'b'),
        now: NOW
      })
    ).rejects.toThrow('journal is full')
  })

  it('hashes the session scope and payload instead of retaining message bodies', () => {
    const first = mobileStructuredSendOperationKey({
      sessionKey: 'host-a:session-a',
      intentFingerprint: 'message-body-fingerprint'
    })
    const second = mobileStructuredSendOperationKey({
      sessionKey: 'host-b:session-a',
      intentFingerprint: 'message-body-fingerprint'
    })

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
    expect(first).not.toContain('message-body')
  })

  it('fails closed when a retained id crosses authenticated caller identities', async () => {
    await getOrCreatePersistedOperation({
      operationKey: OPERATION_KEY,
      callerIdentity: 'mobile-device-before-repair',
      payloadFingerprint: 'b'.repeat(64),
      attachmentPaths: [],
      createOperationId: () => operationIdAt(NOW, '3'),
      now: NOW
    })

    await expect(
      getOrCreatePersistedOperation({
        operationKey: OPERATION_KEY,
        callerIdentity: 'mobile-device-after-repair',
        payloadFingerprint: 'b'.repeat(64),
        attachmentPaths: [],
        createOperationId: () => operationIdAt(NOW, '4'),
        now: NOW
      })
    ).rejects.toThrow('caller identity changed')
  })
})
