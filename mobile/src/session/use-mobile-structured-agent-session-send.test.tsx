import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
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

  it('keeps one id across acknowledgement loss and host unknown replays', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      if (attempts === 1) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return sendResult('unknown')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
    })

    expect(calls()).toHaveLength(3)
    expect(new Set(sentIds()).size).toBe(1)
    expect(calls().every(([, params]) => !('retryUnknown' in (params as object)))).toBe(true)
  })

  it('releases an ack-lost id after the journal accepts it for a later identical intent', async () => {
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
      expect(await hook!.sendWithOutcome('same text, later intent')).toBe('unknown')
    })
    const firstRequest = calls()[0]![1] as {
      envelope: { clientOperationId: string; payloadFingerprint: string }
    }
    const event = snapshotEvent()
    act(() =>
      listener?.({
        ...event,
        page: {
          ...event.page,
          submissions: [
            {
              ...structuredSendResultFixture('accepted').submission,
              clientMessageId: firstRequest.envelope.clientOperationId,
              payloadFingerprint: firstRequest.envelope.payloadFingerprint
            }
          ]
        }
      })
    )
    await vi.waitFor(() => expect(storedOperations.size).toBe(0))

    await act(async () => {
      expect(await hook!.sendWithOutcome('same text, later intent')).toBe('accepted')
    })

    expect(sentIds()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('reuses an ambiguous id after the session hook remounts', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1
        ? Promise.reject(markRpcDeliveryUnknown(new Error('Connection closed')))
        : sendResult('unknown')
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

    expect(new Set(sentIds()).size).toBe(1)
    expect(calls().every(([, params]) => !('retryUnknown' in (params as object)))).toBe(true)
    expect(asyncStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      sendRequest.mock.invocationCallOrder.find(
        (_, index) => sendRequest.mock.calls[index]?.[0] === 'agentSession.send'
      )!
    )
  })

  it('keeps the id when the host fails after provider dispatch', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1
        ? {
            id: 'request-1',
            ok: false as const,
            error: { code: 'runtime_error', message: 'journal resolve failed' },
            _meta: { runtimeId: 'runtime-1' }
          }
        : sendResult('unknown')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('possibly delivered')).toBe('unknown')
      expect(await hook!.sendWithOutcome('possibly delivered')).toBe('unknown')
    })

    expect(calls()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(1)
    expect(calls().every(([, params]) => !('retryUnknown' in (params as object)))).toBe(true)
  })

  it('reuses the original uploaded attachment identity after acknowledgement loss', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      return attempts === 1
        ? Promise.reject(markRpcDeliveryUnknown(new Error('Connection closed')))
        : sendResult('unknown')
    })
    await mountSession()
    const contentFingerprint = 'f'.repeat(64)

    await act(async () => {
      expect(
        await hook!.sendWithOutcome('describe', undefined, undefined, [
          {
            path: '/tmp/original.png',
            previewUri: 'file:///photo.jpg',
            contentFingerprint
          }
        ])
      ).toBe('unknown')
      expect(
        await hook!.sendWithOutcome('describe', undefined, undefined, [
          {
            path: '/tmp/reuploaded.png',
            previewUri: 'file:///photo.jpg',
            contentFingerprint
          }
        ])
      ).toBe('unknown')
    })

    expect(new Set(sentIds()).size).toBe(1)
    expect(calls()[1]?.[1]).toMatchObject({
      body: {
        blocks: expect.arrayContaining([{ type: 'image-ref', path: '/tmp/original.png' }])
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

  it('keeps the send id after a pending-admission refusal', async () => {
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
      expect(await hook!.sendWithOutcome('retry at the current fence')).toBe('unknown')
    })

    expect(sentIds()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(1)
  })

  it('keeps the id when an older host refuses an unknown replay', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      if (attempts === 1) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return attempts === 2
        ? ok({
            ok: false,
            refusal: {
              code: 'agent_session_operation_unknown',
              message: 'The outcome is unknown.'
            }
          })
        : sendResult('unknown')
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('old host replay')).toBe('unknown')
      expect(await hook!.sendWithOutcome('old host replay')).toBe('unknown')
      expect(await hook!.sendWithOutcome('old host replay')).toBe('unknown')
    })

    expect(new Set(sentIds()).size).toBe(1)
    expect(calls().every(([, params]) => !('retryUnknown' in (params as object)))).toBe(true)
  })

  it('keeps an ambiguous id after the host replay window expires', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      }
      attempts += 1
      if (attempts === 1) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return ok({
        ok: false,
        refusal: {
          code: 'agent_session_operation_expired',
          message: 'Operation expired.'
        }
      })
    })
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('old ambiguity')).toBe('unknown')
      expect(await hook!.sendWithOutcome('old ambiguity')).toBe('rejected')
      expect(await hook!.sendWithOutcome('old ambiguity')).toBe('rejected')
    })

    expect(calls()).toHaveLength(3)
    expect(new Set(sentIds()).size).toBe(1)
  })

  it('does not retain an id when the action budget expires before dispatch', async () => {
    await mountSession()

    await act(async () => {
      expect(await hook!.sendWithOutcome('never attempted', undefined, 0)).toBe('rejected')
    })

    expect(calls()).toHaveLength(0)
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
  })
})
