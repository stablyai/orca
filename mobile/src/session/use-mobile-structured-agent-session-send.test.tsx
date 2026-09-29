import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../src/shared/agent-session-host-authority'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

const JOURNAL_KEY = 'orca:mobileStructuredSendOperations:v1'
const SESSION_KEY = encodeNativeChatTranscriptIdentity([
  'host-a\0workspace-a',
  'codex',
  'session-1'
])

function operationIdAt(timestamp: number, entropy: string): string {
  return `${timestamp}-${entropy.repeat(32)}`
}

/** A journal entry exactly as the build before per-press ids wrote it for this harness. */
function v1Entry(text: string, operationId: string) {
  const intentFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'mobile.agentSession.send.intent',
    sessionId: SESSION_KEY,
    fields: { text, attachments: [] }
  })
  return {
    operationKey: structuredAgentSessionPayloadFingerprint({
      method: 'mobile.agentSession.send.operation',
      sessionId: SESSION_KEY,
      fields: { intentFingerprint }
    }),
    operationId,
    callerFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'mobile.agentSession.send.caller',
      sessionId: '',
      fields: {}
    }),
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { body: structuredAgentSessionSendBody(text, []) }
    }),
    attachmentPaths: []
  }
}

function v1Journal(entries: readonly ReturnType<typeof v1Entry>[]): string {
  return JSON.stringify({ v: 1, entries })
}

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function sendResult(dispatchState: AgentJournalDispatchState) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: structuredSendResultFixture(dispatchState)
  })
}

function snapshotEvent(): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: { epoch: 'epoch-1', sequence: 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

describe('mobile structured send retries', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let storedOperations: Map<string, string>
  const onSendError = vi.fn()
  const sendRequest = vi.fn()
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return vi.fn()
  })
  const client = { sendRequest, subscribe } as unknown as RpcClient

  function Harness(): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError
    } as never)
    return null
  }

  async function mountSession(): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))
  }

  function calls() {
    return sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
  }

  function sentIds(): string[] {
    return calls().map(
      ([, params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    storedOperations = new Map()
    asyncStorage.getItem.mockImplementation(
      async (key: string) => storedOperations.get(key) ?? null
    )
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      storedOperations.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      storedOperations.delete(key)
    })
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  })

  it.each([
    ['an acknowledgement loss', () => Promise.reject(markRpcDeliveryUnknown(new Error('Closed')))],
    [
      'a host failure after dispatch',
      async () => ({
        id: 'request-1',
        ok: false as const,
        error: { code: 'runtime_error', message: 'journal resolve failed' },
        _meta: { runtimeId: 'runtime-1' }
      })
    ],
    [
      'an unknown-outcome refusal',
      async () =>
        ok({
          ok: false,
          refusal: { code: 'agent_session_operation_unknown', message: 'The outcome is unknown.' }
        })
    ]
  ])('sends the same text again after %s, as a second message', async (_, firstAnswer) => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1 ? firstAnswer() : sendResult('accepted')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('same text')).toBe('unknown')
      expect(await hook!.sendWithOutcome('same text')).toBe('accepted')
    })

    expect(calls()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('writes nothing to the device for a send, so a remount mints a new id', async () => {
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      throw markRpcDeliveryUnknown(new Error('Connection closed'))
    })
    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('survive remount')).toBe('unknown')
    })
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null

    await mountSession()
    await act(async () => {
      expect(await hook!.sendWithOutcome('survive remount')).toBe('unknown')
    })

    expect(new Set(sentIds()).size).toBe(2)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('sends a re-uploaded attachment as its own message', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1
        ? Promise.reject(markRpcDeliveryUnknown(new Error('Connection closed')))
        : sendResult('accepted')
    })
    await mountSession()

    await act(async () => {
      for (const path of ['/tmp/original.png', '/tmp/reuploaded.png']) {
        await hook!.sendWithOutcome('describe', undefined, undefined, [
          { path, previewUri: 'file:///photo.jpg' }
        ])
      }
    })

    expect(new Set(sentIds()).size).toBe(2)
    expect(calls()[1]?.[1]).toMatchObject({
      body: {
        blocks: expect.arrayContaining([{ type: 'image-ref', path: '/tmp/reuploaded.png' }])
      }
    })
  })

  it.each(['invalid_argument', 'unauthorized'])(
    'rotates after a %s pre-handler RPC refusal that proves the send did not run',
    async (code) => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method !== 'agentSession.send') {
          return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
        }
        attempts += 1
        return attempts === 1
          ? {
              ok: false as const,
              error: { code, message: 'Message is not authorized' },
              _meta: { runtimeId: 'runtime-1' }
            }
          : sendResult('accepted')
      })
      await mountSession()

      await act(async () => {
        expect(await hook!.sendWithOutcome('never reached the handler')).toBe('rejected')
        expect(await hook!.sendWithOutcome('never reached the handler')).toBe('accepted')
      })

      expect(sentIds()).toHaveLength(2)
      expect(new Set(sentIds()).size).toBe(2)
    }
  )

  it('sends a press after a pending-admission refusal under a new id', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1
        ? ok({
            ok: false,
            refusal: {
              code: 'agent_session_checkpoint_stale',
              message: 'Fence moved',
              currentFence: 3
            }
          })
        : sendResult('accepted')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('retry at the current fence')).toBe('rejected')
      expect(await hook!.sendWithOutcome('retry at the current fence')).toBe('accepted')
    })

    expect(sentIds()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('does not join a v1 entry an earlier build left for the same text', async () => {
    const leftOver = operationIdAt(Date.now(), 'a')
    const journal = v1Journal([v1Entry('same text as before the update', leftOver)])
    storedOperations.set(JOURNAL_KEY, journal)
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      return sendResult('accepted')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('same text as before the update')).toBe('accepted')
    })

    expect(sentIds()).toHaveLength(1)
    expect(sentIds()[0]).not.toBe(leftOver)
    expect(storedOperations.get(JOURNAL_KEY)).toBe(journal)
  })

  it('clears a v1 entry once the host shows it settled', async () => {
    const leftOver = operationIdAt(Date.now(), 'b')
    const entry = v1Entry('sent before the update', leftOver)
    storedOperations.set(JOURNAL_KEY, v1Journal([entry]))
    await mountSession()
    const event = snapshotEvent()
    act(() =>
      listener?.({
        ...event,
        page: {
          ...event.page,
          submissions: [
            {
              ...structuredSendResultFixture('accepted').submission,
              clientMessageId: leftOver,
              payloadFingerprint: entry.payloadFingerprint
            }
          ]
        }
      })
    )

    await vi.waitFor(() => expect(storedOperations.has(JOURNAL_KEY)).toBe(false))
  })

  it('prunes v1 entries past the host replay window and keeps younger ones', async () => {
    const now = Date.now()
    const young = v1Entry('young', operationIdAt(now - 60_000, 'c'))
    storedOperations.set(
      JOURNAL_KEY,
      v1Journal([
        v1Entry(
          'expired',
          operationIdAt(now - AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS - 60_000, 'd')
        ),
        young
      ])
    )
    await mountSession()

    await vi.waitFor(() => expect(storedOperations.get(JOURNAL_KEY)).toBe(v1Journal([young])))
  })

  it('does not retain an id when the action budget expires before dispatch', async () => {
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('never attempted', undefined, 0)).toBe('rejected')
    })

    expect(calls()).toHaveLength(0)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('sends even when the device store refuses every read and write', async () => {
    asyncStorage.getItem.mockRejectedValue(new Error('storage unavailable'))
    asyncStorage.setItem.mockRejectedValue(
      new Error('Orca could not save orca:mobileStructuredSendOperations:v1')
    )
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      return sendResult('accepted')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('the store is broken')).toBe('accepted')
    })

    expect(onSendError).not.toHaveBeenCalled()
    expect(calls()).toHaveLength(1)
  })
})
