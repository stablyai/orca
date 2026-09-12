import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'
import type { PtyHandler } from './pty-handler'
import type { RequestContext } from './dispatcher'
import {
  encodeJsonRpcFrame,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './protocol'

const dispatchers: RelayDispatcher[] = []

function lifecycleFixture(dispatcher: RelayDispatcher) {
  const dispose = vi.fn(async () => {})
  const lifecycle = new RelayGraceLifecycle({
    dispatcher,
    ptyHandler: {
      setOwnershipTransferGraceGuardEnabled: vi.fn(),
      cancelGraceTimer: vi.fn(),
      hasLiveOwnershipTransferFence: false,
      dispose
    } as unknown as PtyHandler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => 1,
    hasAcceptedSocketClient: () => true,
    ownsSocketPath: () => true,
    disposeOwnedProcesses: vi.fn(async () => {}),
    disposeRuntime: vi.fn()
  })
  return { lifecycle, dispose }
}
afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) {
    dispatcher.dispose()
  }
})
function fixture() {
  const responses: Record<string, unknown>[] = []
  const dispatcher = new RelayDispatcher((frame) => {
    const length = frame.readUInt32BE(9)
    responses.push(JSON.parse(frame.subarray(13, 13 + length).toString()))
    return true
  })
  dispatchers.push(dispatcher)
  let sequence = 0
  const send = (
    message:
      | Omit<JsonRpcRequest, 'jsonrpc'>
      | Omit<JsonRpcResponse, 'jsonrpc'>
      | Omit<JsonRpcNotification, 'jsonrpc'>
  ) => dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', ...message }, ++sequence, 0))
  return { dispatcher, responses, send }
}

it('rejects new mutations over the wire while waiting for uncancellable admitted work', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  const mutation = vi.fn(() => pending.promise)
  f.dispatcher.onRequest('fs.writeFile', mutation)
  f.send({ id: 1, method: 'fs.writeFile' })
  const drained = vi.fn()
  const drain = f.dispatcher.beginWorkDrain().then(drained)
  f.send({ id: 2, method: 'fs.writeFile' })
  await vi.waitFor(() =>
    expect(f.responses).toContainEqual(
      expect.objectContaining({
        id: 2,
        error: expect.objectContaining({ message: 'relay_work_admission_closed' })
      })
    )
  )
  expect(mutation).toHaveBeenCalledOnce()
  expect(drained).not.toHaveBeenCalled()
  pending.resolve()
  await drain
})

it('request-initiated shutdown excludes only itself and refuses duplicate waiters without deadlock', async () => {
  const f = fixture()
  const { lifecycle, dispose } = lifecycleFixture(f.dispatcher)
  const work = Promise.withResolvers<void>()
  f.dispatcher.onRequest('fs.writeFile', () => work.promise)
  f.dispatcher.onRequest('relay.reset', async (_params, context) => {
    await lifecycle.prepareShutdown(context)
    return { prepared: true }
  })
  f.send({ id: 1, method: 'fs.writeFile' })
  f.send({ id: 2, method: 'relay.reset' })
  f.send({ id: 3, method: 'relay.reset' })
  try {
    await vi.waitFor(() =>
      expect(f.responses).toContainEqual(
        expect.objectContaining({
          id: 3,
          error: expect.objectContaining({ message: 'relay_shutdown_preparation_in_progress' })
        })
      )
    )
    expect(f.responses.some((response) => response.id === 2)).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
    work.resolve()
    await vi.waitFor(() =>
      expect(f.responses).toContainEqual({
        jsonrpc: '2.0',
        id: 2,
        result: { prepared: true }
      })
    )
  } finally {
    work.resolve()
  }
})

it('rejects copied and settled initiators before disposing or fencing new work', async () => {
  const f = fixture()
  const { lifecycle, dispose } = lifecycleFixture(f.dispatcher)
  let actual: RequestContext | undefined
  f.dispatcher.onRequest('test.capture', async (_params, context) => {
    actual = context
    await expect(lifecycle.prepareShutdown({ ...context })).rejects.toThrow(
      'relay_work_drain_context_not_active'
    )
    return 'captured'
  })
  f.send({ id: 1, method: 'test.capture' })
  await vi.waitFor(() => expect(f.responses.some((response) => response.id === 1)).toBe(true))
  await expect(lifecycle.prepareShutdown(actual!)).rejects.toThrow(
    'relay_work_drain_context_not_active'
  )
  expect(dispose).not.toHaveBeenCalled()
  const mutate = vi.fn(async () => 'still open')
  f.dispatcher.onRequest('fs.writeFile', mutate)
  f.send({ id: 2, method: 'fs.writeFile' })
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
})

it('preserves ACK notifications and cancellation during drain without admitting new notifications', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  f.dispatcher.onRequest('git.diff', (_params, context) => {
    signal = context.signal
    return pending.promise
  })
  const write = vi.fn()
  const ack = vi.fn(() => pending.resolve())
  f.dispatcher.onNotification('pty.write', write)
  f.dispatcher.onNotification('git.responseAck', ack)
  f.send({ id: 1, method: 'git.diff' })
  const drain = f.dispatcher.beginWorkDrain()
  f.send({ method: 'pty.write' })
  f.send({ method: 'rpc.cancel', params: { id: 1 } })
  expect(signal?.aborted).toBe(true)
  f.send({ method: 'git.responseAck' })
  await drain
  expect(write).not.toHaveBeenCalled()
  expect(ack).toHaveBeenCalledOnce()
})

it('lets an admitted operation receive its reverse RPC response while draining', async () => {
  const f = fixture()
  f.dispatcher.onRequest('orca.cli', () => f.dispatcher.requestPrimary('client.operation'))
  f.send({ id: 10, method: 'orca.cli' })
  const drain = f.dispatcher.beginWorkDrain()
  const request = f.responses.find((frame) => frame.method === 'client.operation')!
  expect(request).toBeDefined()
  f.send({ id: Number(request.id), result: 'done' })
  await drain
  await vi.waitFor(() =>
    expect(f.responses).toContainEqual({ jsonrpc: '2.0', id: 10, result: 'done' })
  )
})

it('keeps skill upload cancellation executable while admitted installation work drains', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.dispatcher.onRequest('skills.install', () => work.promise)
  const cancel = vi.fn(async () => work.resolve())
  f.dispatcher.onRequest('skills.cancelUpload', cancel)
  f.send({ id: 1, method: 'skills.install' })
  const drain = f.dispatcher.beginWorkDrain()
  f.send({ id: 2, method: 'skills.cancelUpload' })
  await drain
  expect(cancel).toHaveBeenCalledOnce()
})

it('real shutdown refuses new framed work and joins cleanup arriving during producer disposal', async () => {
  const f = fixture()
  const mutation = Promise.withResolvers<void>()
  const producers = Promise.withResolvers<void>()
  const unwatch = Promise.withResolvers<void>()
  const write = vi.fn(() => mutation.promise)
  const cleanup = vi.fn(() => unwatch.promise)
  const disposeOwnedProcesses = vi.fn(() => producers.promise)
  f.dispatcher.onRequest('fs.writeFile', write)
  f.dispatcher.onRequest('fs.unwatchAndWait', cleanup)
  const lifecycle = new RelayGraceLifecycle({
    dispatcher: f.dispatcher,
    ptyHandler: {
      setOwnershipTransferGraceGuardEnabled: vi.fn(),
      cancelGraceTimer: vi.fn(),
      hasLiveOwnershipTransferFence: false,
      dispose: vi.fn(async () => {})
    } as unknown as PtyHandler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => 1,
    hasAcceptedSocketClient: () => true,
    ownsSocketPath: () => true,
    disposeOwnedProcesses,
    disposeRuntime: vi.fn()
  })
  f.send({ id: 1, method: 'fs.writeFile' })
  const finished = vi.fn()
  const preparation = lifecycle.prepareShutdown().then(finished)
  try {
    f.send({ id: 2, method: 'fs.writeFile' })
    await vi.waitFor(() =>
      expect(f.responses).toContainEqual(
        expect.objectContaining({
          id: 2,
          error: expect.objectContaining({ message: 'relay_work_admission_closed' })
        })
      )
    )
    expect(write).toHaveBeenCalledOnce()
    expect(disposeOwnedProcesses).not.toHaveBeenCalled()
    mutation.resolve()
    await vi.waitFor(() => expect(disposeOwnedProcesses).toHaveBeenCalledOnce())
    f.send({ id: 3, method: 'fs.unwatchAndWait' })
    expect(cleanup).toHaveBeenCalledOnce()
    producers.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    expect(() => lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
    unwatch.resolve()
    await preparation
    expect(finished).toHaveBeenCalledOnce()
  } finally {
    mutation.resolve()
    producers.resolve()
    unwatch.resolve()
    await preparation
  }
})
