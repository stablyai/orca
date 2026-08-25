import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, type JsonRpcRequest } from './protocol'

const LONG_REQUEST_TIMEOUT_MS = 10 * 60_000

function decodeRequest(frame: Buffer): JsonRpcRequest {
  const length = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(13, 13 + length).toString('utf-8')) as JsonRpcRequest
}

async function immediateOutcome(promise: Promise<unknown>): Promise<string> {
  let outcome = 'pending'
  void promise.then(
    () => {
      outcome = 'resolved'
    },
    (error: unknown) => {
      outcome = `rejected:${error instanceof Error ? error.message : String(error)}`
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  return outcome
}

describe('RelayDispatcher detached client requests', () => {
  let dispatcher: RelayDispatcher

  beforeEach(() => {
    vi.useFakeTimers()
    dispatcher = new RelayDispatcher(() => {})
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it('rejects a pending request immediately when its target client detaches', async () => {
    const ownerWritten: Buffer[] = []
    const ownerId = dispatcher.attachClient((data) => {
      ownerWritten.push(Buffer.from(data))
    })
    const pending = dispatcher.requestAnyClient('orca.cli', undefined, {
      timeoutMs: LONG_REQUEST_TIMEOUT_MS
    })

    expect(ownerWritten).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(2)

    dispatcher.detachClient(ownerId)

    await expect(immediateOutcome(pending)).resolves.toBe(
      `rejected:Client ${ownerId} detached while request was pending`
    )
    expect(vi.getTimerCount()).toBe(1)
  })

  it("preserves another client's pending request when one client detaches", async () => {
    dispatcher.invalidateClient()
    const firstWritten: Buffer[] = []
    const secondWritten: Buffer[] = []
    const firstId = dispatcher.attachClient((data) => {
      firstWritten.push(Buffer.from(data))
    })
    const secondId = dispatcher.attachClient((data) => {
      secondWritten.push(Buffer.from(data))
    })
    const firstPending = dispatcher.requestAnyClient('first.request', undefined, {
      timeoutMs: LONG_REQUEST_TIMEOUT_MS
    })
    const secondPending = dispatcher.requestAnyClient('second.request', undefined, {
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      excludeClientId: firstId
    })

    expect(firstWritten).toHaveLength(1)
    expect(secondWritten).toHaveLength(1)

    dispatcher.detachClient(firstId)

    await expect(immediateOutcome(firstPending)).resolves.toBe(
      `rejected:Client ${firstId} detached while request was pending`
    )
    await expect(immediateOutcome(secondPending)).resolves.toBe('pending')

    const secondRequest = decodeRequest(secondWritten[0])
    dispatcher.feedClient(
      secondId,
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: secondRequest.id, result: 'second-result' }, 1, 0)
    )
    await expect(secondPending).resolves.toBe('second-result')
  })

  it('does not revive an invalidated primary request or accept its late response', async () => {
    const primaryWritten: Buffer[] = []
    dispatcher.dispose()
    dispatcher = new RelayDispatcher((data) => {
      primaryWritten.push(Buffer.from(data))
    })
    const oldPending = dispatcher.requestPrimary('old.request', undefined, {
      timeoutMs: LONG_REQUEST_TIMEOUT_MS
    })
    const oldRequest = decodeRequest(primaryWritten[0])

    dispatcher.invalidateClient()
    dispatcher.invalidateClient()

    await expect(immediateOutcome(oldPending)).resolves.toBe(
      'rejected:Client 1 detached while request was pending'
    )

    const revivedWritten: Buffer[] = []
    dispatcher.setWrite((data) => {
      revivedWritten.push(Buffer.from(data))
    })
    const revivedPending = dispatcher.requestPrimary('revived.request', undefined, {
      timeoutMs: LONG_REQUEST_TIMEOUT_MS
    })
    const revivedRequest = decodeRequest(revivedWritten[0])

    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: oldRequest.id, result: 'late' }, 1, 0))
    await expect(immediateOutcome(revivedPending)).resolves.toBe('pending')

    dispatcher.feed(
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: revivedRequest.id, result: 'revived' }, 2, 0)
    )
    await expect(revivedPending).resolves.toBe('revived')
    expect(vi.getTimerCount()).toBe(1)
  })
})
