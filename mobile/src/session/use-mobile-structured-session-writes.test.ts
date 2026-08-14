import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionOptionResult,
  AgentSessionWireRefusalCode
} from '../../../src/shared/agent-session-wire'
import type * as MobileStructuredOutboxStore from './mobile-structured-outbox-store'
import {
  loadMobileStructuredOutbox,
  saveMobileStructuredOutbox
} from './mobile-structured-outbox-store'
import {
  useMobileStructuredSessionWrites,
  type MobileStructuredSessionWrites
} from './use-mobile-structured-session-writes'

vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }))
vi.mock('./mobile-structured-outbox-store', async (importOriginal) => {
  const original = await importOriginal<typeof MobileStructuredOutboxStore>()
  return { ...original, loadMobileStructuredOutbox: vi.fn(), saveMobileStructuredOutbox: vi.fn() }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function accepted(id: string): RpcSuccess {
  return {
    id,
    ok: true,
    _meta: { runtimeId: 'runtime-1' },
    result: {
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'epoch-1', sequence: 2 },
      value: {
        clientMessageId: id,
        submission: {
          clientMessageId: id,
          fence: 3,
          payloadFingerprint: 'a'.repeat(64),
          dispatchState: 'accepted',
          providerItemId: 'codex:thread:turn:0',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    }
  }
}

function refused(code: AgentSessionWireRefusalCode): RpcSuccess {
  return {
    id: code,
    ok: true,
    _meta: { runtimeId: 'runtime-1' },
    result: { ok: false, refusal: { code, message: code } }
  }
}

describe('useMobileStructuredSessionWrites', () => {
  let renderer: ReactTestRenderer | null = null
  let api: MobileStructuredSessionWrites | null = null
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = {
    sendRequest,
    getState: () => 'connected' as const
  } as RpcClient
  let connected = true
  let fence = 3
  let sessionId = 'mobile_1'
  let submissions: AgentJournalSubmission[] = []

  function Probe(): null {
    api = useMobileStructuredSessionWrites({
      client,
      connected,
      sessionId,
      fence,
      submissions
    })
    return null
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(loadMobileStructuredOutbox).mockReset().mockResolvedValue([])
    vi.mocked(saveMobileStructuredOutbox).mockReset().mockResolvedValue(undefined)
    sendRequest.mockReset()
    connected = true
    fence = 3
    sessionId = 'mobile_1'
    submissions = []
    const crypto = await import('expo-crypto')
    vi.mocked(crypto.randomUUID)
      .mockReset()
      .mockReturnValue('00000000-0000-4000-8000-000000000099')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    api = null
  })

  it('persists before dispatch and allows only one in-flight send', async () => {
    const first = deferred<RpcSuccess>()
    sendRequest.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(accepted('two'))

    await act(async () => {
      await api!.send('one')
      await api!.send('two')
      await Promise.resolve()
    })

    expect(saveMobileStructuredOutbox).toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
    const firstId = (sendRequest.mock.calls[0]![1] as { envelope: { clientOperationId: string } })
      .envelope.clientOperationId

    await act(async () => {
      first.resolve(accepted(firstId))
      await first.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('dispatches the first send after a fresh session finishes outbox hydration', async () => {
    act(() => renderer?.unmount())
    renderer = null
    api = null
    const hydration = deferred<MobileStructuredOutboxStore.MobileStructuredOutboxEntry[]>()
    vi.mocked(loadMobileStructuredOutbox).mockReset().mockReturnValue(hydration.promise)
    sendRequest.mockImplementation(async (_method, params) =>
      accepted((params as { envelope: { clientOperationId: string } }).envelope.clientOperationId)
    )
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })

    let sending!: Promise<boolean>
    act(() => {
      sending = api!.send('first message')
    })
    expect(sendRequest).not.toHaveBeenCalled()
    expect(saveMobileStructuredOutbox).not.toHaveBeenCalled()

    await act(async () => {
      hydration.resolve([])
      await expect(sending).resolves.toBe(true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({ sessionId: 'mobile_1', expectedRuntimeFence: 3 })
      })
    )
    expect(api!.outbox).toEqual([])
  })

  it('does not install a saved outbox entry after switching sessions', async () => {
    const saved = deferred<void>()
    vi.mocked(saveMobileStructuredOutbox).mockReturnValueOnce(saved.promise)

    let sending!: Promise<boolean>
    act(() => {
      sending = api!.send('old session message')
    })
    await vi.waitFor(() => expect(saveMobileStructuredOutbox).toHaveBeenCalledTimes(1))

    sessionId = 'mobile_2'
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
    })
    expect(api!.outbox).toEqual([])

    await act(async () => {
      saved.resolve()
      await expect(sending).resolves.toBe(false)
      await Promise.resolve()
    })

    expect(api!.outbox).toEqual([])
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('serializes concurrent sends against the latest durable outbox', async () => {
    connected = false
    act(() => renderer!.update(createElement(Probe)))
    const firstSave = deferred<void>()
    vi.mocked(saveMobileStructuredOutbox).mockReturnValueOnce(firstSave.promise)

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = api!.send('one')
      second = api!.send('two')
    })
    await vi.waitFor(() => expect(saveMobileStructuredOutbox).toHaveBeenCalledTimes(1))

    await act(async () => {
      firstSave.resolve()
      await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    })

    expect(api!.outbox.map((entry) => entry.body.blocks[0])).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' }
    ])
    expect(saveMobileStructuredOutbox).toHaveBeenLastCalledWith('mobile_1', api!.outbox)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each(['agent_session_operation_conflict', 'agent_session_operation_expired'] as const)(
    'rotates a send operation after %s',
    async (code) => {
      sendRequest
        .mockResolvedValueOnce(refused(code))
        .mockImplementationOnce(async (_method, params) =>
          accepted(
            (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
          )
        )

      await act(async () => {
        await api!.send('hello')
        await Promise.resolve()
        await Promise.resolve()
      })
      const firstId = (sendRequest.mock.calls[0]![1] as { envelope: { clientOperationId: string } })
        .envelope.clientOperationId
      const retryId = api!.outbox[0]!.clientMessageId
      expect(retryId).not.toBe(firstId)

      await act(async () => {
        await api!.retry(retryId)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(sendRequest).toHaveBeenCalledTimes(2)
      expect(
        (sendRequest.mock.calls[1]![1] as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
      ).toBe(retryId)
    }
  )

  it('retains a send operation after a pending-admission refusal', async () => {
    sendRequest
      .mockResolvedValueOnce(refused('agent_session_checkpoint_stale'))
      .mockImplementationOnce(async (_method, params) =>
        accepted((params as { envelope: { clientOperationId: string } }).envelope.clientOperationId)
      )

    await act(async () => {
      await api!.send('hello')
      await Promise.resolve()
      await Promise.resolve()
    })
    const firstId = (sendRequest.mock.calls[0]![1] as { envelope: { clientOperationId: string } })
      .envelope.clientOperationId
    expect(api!.outbox[0]?.clientMessageId).toBe(firstId)

    await act(async () => {
      await api!.retry(firstId)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(
      (sendRequest.mock.calls[1]![1] as { envelope: { clientOperationId: string } }).envelope
        .clientOperationId
    ).toBe(firstId)
  })

  it('retries a durable unknown by the same id before dispatching later messages', async () => {
    sendRequest.mockImplementation(async (_method, params) => {
      const id = (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      if (sendRequest.mock.calls.length === 1) {
        const response = accepted(id)
        return {
          ...response,
          result: {
            ...(response.result as object),
            value: {
              ...(response.result as { value: object }).value,
              submission: {
                ...(response.result as { value: { submission: object } }).value.submission,
                dispatchState: 'unknown'
              }
            }
          }
        }
      }
      return accepted(id)
    })

    await act(async () => {
      await api!.send('possibly delivered')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api!.outbox[0]?.state).toBe('unconfirmed')
    const firstId = api!.outbox[0]!.clientMessageId
    submissions = [
      {
        clientMessageId: firstId,
        fence: 3,
        payloadFingerprint: 'a'.repeat(64),
        dispatchState: 'unknown',
        providerItemId: null,
        reason: 'reply lost',
        submittedAt: 11,
        resolvedAt: 12
      }
    ]

    await act(async () => {
      renderer!.update(createElement(Probe))
      await api!.send('later')
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      await api!.retry(firstId)
      await Promise.resolve()
      await Promise.resolve()
    })

    const retryId = (sendRequest.mock.calls[1]![1] as { envelope: { clientOperationId: string } })
      .envelope.clientOperationId
    expect(retryId).toBe(firstId)
    expect(sendRequest.mock.calls[1]![1]).toMatchObject({ retryUnknown: true })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })

  it('unblocks a refused queued head when the runtime fence advances', async () => {
    sendRequest
      .mockResolvedValueOnce({
        ...accepted('refused'),
        result: {
          ok: false,
          refusal: { code: 'agent_session_fence_stale', message: 'stale fence', retryable: true }
        }
      })
      .mockImplementationOnce(async (_method, params) => {
        const id = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return accepted(id)
      })

    await act(async () => {
      await api!.send('retry after reconnect')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(api!.outbox[0]?.state).toBe('queued')

    fence = 4
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(
      (sendRequest.mock.calls[1]![1] as { envelope: { expectedRuntimeFence: number } }).envelope
        .expectedRuntimeFence
    ).toBe(4)
  })

  it('requeues an in-flight stale-fence response under the replacement fence', async () => {
    const oldResponse = deferred<RpcSuccess>()
    sendRequest
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(async (_method, params) => {
        const id = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return accepted(id)
      })

    await act(async () => {
      await api!.send('survive reattach')
      await Promise.resolve()
    })
    fence = 4
    await act(async () => {
      renderer!.update(createElement(Probe))
      oldResponse.resolve({
        ...accepted('stale'),
        result: {
          ok: false,
          refusal: { code: 'agent_session_fence_stale', message: 'stale fence', retryable: true }
        }
      })
      await oldResponse.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(
      (sendRequest.mock.calls[1]![1] as { envelope: { expectedRuntimeFence: number } }).envelope
        .expectedRuntimeFence
    ).toBe(4)
  })

  it('retries an unresolved dispatch after a same-fence reconnect', async () => {
    const oldResponse = deferred<RpcSuccess>()
    sendRequest
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(async (_method, params) => {
        const id = (params as { envelope: { clientOperationId: string } }).envelope
          .clientOperationId
        return accepted(id)
      })

    await act(async () => {
      await api!.send('survive reconnect')
      await Promise.resolve()
    })
    connected = false
    act(() => renderer!.update(createElement(Probe)))
    connected = true
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(api!.outbox).toEqual([])

    await act(async () => {
      oldResponse.resolve(accepted('stale'))
      await oldResponse.promise
    })
    expect(api!.outbox).toEqual([])
  })

  it('answers a durable approval with its expected revision compare-and-set', async () => {
    sendRequest.mockResolvedValue({
      ...accepted('approval'),
      result: {
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 4 },
        value: {
          itemId: 'orca:approval-1',
          revision: 8,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'accept',
            resolvedBy: 'mobile',
            resolvedAt: 2
          }
        }
      }
    })

    await act(async () => {
      await api!.respondToPrompt(
        {
          itemId: 'orca:approval-1',
          revision: 7,
          sequence: 3,
          observedAt: 1,
          body: {
            kind: 'approval',
            title: 'Run command?',
            detail: 'pnpm test',
            options: [{ id: 'accept', label: 'Allow' }],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        },
        'accept'
      )
    })

    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToApproval',
      expect.objectContaining({
        itemId: 'orca:approval-1',
        expectedRevision: 7,
        optionId: 'accept',
        envelope: expect.objectContaining({ expectedRuntimeFence: 3 })
      })
    )
  })

  it('turns an RPC failure response into a handled mutation error', async () => {
    sendRequest.mockResolvedValue({
      id: 'set-option',
      ok: false,
      _meta: { runtimeId: 'runtime-1' },
      error: { code: 'forbidden', message: 'not allowed' }
    })

    let applied!: AgentSessionOptionResult | null
    await act(async () => {
      applied = await api!.setOption('model', 'gpt-5.6-sol')
    })

    expect(applied).toBeNull()
    expect(api!.error).toBe('not allowed')
  })

  it('mints a fresh operation when the same option is retried after a typed refusal', async () => {
    sendRequest
      .mockResolvedValueOnce({
        id: 'set-option-rejected',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: 'model list unavailable'
          }
        }
      })
      .mockResolvedValueOnce({
        id: 'set-option-applied',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'epoch-1', sequence: 2 },
          value: {
            key: 'model',
            value: 'gpt-5.6-sol',
            options: { model: 'gpt-5.6-sol' }
          }
        }
      })

    await act(async () => {
      expect(await api!.setOption('model', 'gpt-5.6-sol')).toBeNull()
      expect(await api!.setOption('model', 'gpt-5.6-sol')).toMatchObject({
        options: { model: 'gpt-5.6-sol' }
      })
    })

    const operationIds = sendRequest.mock.calls.map(
      ([, params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
    expect(operationIds[0]).toMatch(/-00000000000040008000000000000001$/)
    expect(operationIds[1]).toMatch(/-00000000000040008000000000000002$/)
    expect(operationIds[1]).not.toBe(operationIds[0])
  })

  it('reuses an option operation after a pending admission refusal', async () => {
    sendRequest
      .mockResolvedValueOnce({
        id: 'set-option-stale',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_checkpoint_stale',
            message: 'runtime fence advanced',
            currentFence: 4
          }
        }
      })
      .mockResolvedValueOnce({
        id: 'set-option-replayed',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: true,
          replayed: false,
          fence: 4,
          cursor: { epoch: 'epoch-1', sequence: 2 },
          value: {
            key: 'model',
            value: 'gpt-5.6-sol',
            options: { model: 'gpt-5.6-sol' }
          }
        }
      })

    await act(async () => {
      expect(await api!.setOption('model', 'gpt-5.6-sol')).toBeNull()
    })
    fence = 4
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      expect(await api!.setOption('model', 'gpt-5.6-sol')).toMatchObject({
        options: { model: 'gpt-5.6-sol' }
      })
    })

    const operationIds = sendRequest.mock.calls.map(
      ([, params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
    expect(operationIds[0]).toBe(operationIds[1])
    expect(operationIds[0]).toMatch(/-00000000000040008000000000000001$/)
    expect(
      sendRequest.mock.calls.map(
        ([, params]) =>
          (params as { envelope: { expectedRuntimeFence: number } }).envelope.expectedRuntimeFence
      )
    ).toEqual([3, 4])
    const crypto = await import('expo-crypto')
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('mints a fresh handoff operation after a settled refusal', async () => {
    sendRequest
      .mockResolvedValueOnce({
        id: 'handoff-stale',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_checkpoint_stale',
            message: 'runtime fence advanced',
            currentFence: 4
          }
        }
      })
      .mockResolvedValueOnce({
        id: 'handoff-started',
        ok: true,
        _meta: { runtimeId: 'runtime-1' },
        result: {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'epoch-1', sequence: 2 },
          value: {
            status: {
              owner: 'native',
              direction: 'to-tui',
              phase: 'switching',
              stage: 'preparing',
              operationId: 'second-operation'
            }
          }
        }
      })

    await act(async () => {
      expect(await api!.requestHandoff('to-tui', 'now')).toBe(false)
      expect(await api!.requestHandoff('to-tui', 'now')).toBe(true)
    })

    const operationIds = sendRequest.mock.calls.map(
      ([, params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
    expect(operationIds[0]).toMatch(/-00000000000040008000000000000001$/)
    expect(operationIds[1]).toMatch(/-00000000000040008000000000000002$/)
    expect(operationIds[1]).not.toBe(operationIds[0])
  })

  it('isolates mutation ids and late errors across session changes', async () => {
    const first = deferred<RpcSuccess>()
    sendRequest.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(accepted('b'))

    let mutationA!: Promise<AgentSessionOptionResult | null>
    act(() => {
      mutationA = api!.setOption('model', 'gpt-5.6-sol')
    })
    const operationA = (
      sendRequest.mock.calls[0]![1] as { envelope: { clientOperationId: string } }
    ).envelope.clientOperationId

    sessionId = 'mobile_2'
    await act(async () => {
      renderer!.update(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await api!.setOption('model', 'gpt-5.6-sol')
    })
    const operationB = (
      sendRequest.mock.calls[1]![1] as { envelope: { clientOperationId: string } }
    ).envelope.clientOperationId
    expect(operationB).not.toBe(operationA)

    await act(async () => {
      first.resolve({
        id: 'a',
        ok: false,
        _meta: { runtimeId: 'runtime-1' },
        error: { code: 'failed', message: 'late session A failure' }
      })
      await mutationA
    })
    expect(api!.error).toBeNull()
  })
})
