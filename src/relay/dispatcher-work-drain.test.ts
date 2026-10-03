import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import type { RequestContext } from './dispatcher'
import {
  encodeJsonRpcFrame,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './protocol'

const dispatchers: RelayDispatcher[] = []

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

it('excludes only the initiating request from its own drain', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.dispatcher.onRequest('fs.writeFile', () => work.promise)
  const drained = vi.fn()
  f.dispatcher.onRequest('test.drain', async (_params, context) => {
    await f.dispatcher.beginWorkDrain(context)
    drained()
    return 'drained'
  })
  f.send({ id: 1, method: 'fs.writeFile' })
  f.send({ id: 2, method: 'test.drain' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(drained).not.toHaveBeenCalled()
  work.resolve()
  await vi.waitFor(() =>
    expect(f.responses).toContainEqual({ jsonrpc: '2.0', id: 2, result: 'drained' })
  )
})

it('rejects copied and settled initiators without closing admission', async () => {
  const f = fixture()
  let actual: RequestContext | undefined
  f.dispatcher.onRequest('test.capture', async (_params, context) => {
    actual = context
    await expect(f.dispatcher.beginWorkDrain({ ...context })).rejects.toThrow(
      'relay_work_drain_context_not_active'
    )
    return 'captured'
  })
  f.send({ id: 1, method: 'test.capture' })
  await vi.waitFor(() => expect(f.responses.some((response) => response.id === 1)).toBe(true))
  expect(() => f.dispatcher.assertActiveWorkContext(actual!)).toThrow(
    'relay_work_drain_context_not_active'
  )
  const mutate = vi.fn(async () => 'still open')
  f.dispatcher.onRequest('fs.writeFile', mutate)
  f.send({ id: 2, method: 'fs.writeFile' })
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
})

it('stamps the transport generation on request and notification contexts', async () => {
  const f = fixture()
  const seen: (number | undefined)[] = []
  f.dispatcher.onRequest('test.request', async (_params, context) => {
    seen.push(context.transportGeneration)
    return 'ok'
  })
  f.dispatcher.onNotification('test.notify', (_params, context) => {
    seen.push(context.transportGeneration)
  })
  f.send({ id: 1, method: 'test.request' })
  f.send({ method: 'test.notify' })
  await vi.waitFor(() => expect(seen).toHaveLength(2))
  expect(seen[0]).toEqual(expect.any(Number))
  expect(seen[1]).toBe(seen[0])
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

it('keeps PTY source delivery cancellation executable while admitted work drains', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.dispatcher.onRequest('pty.attach', () => work.promise)
  const cancel = vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
  f.dispatcher.onRequest('pty.cancelDelivery', cancel)
  f.send({ id: 1, method: 'pty.attach' })
  const drain = f.dispatcher.beginWorkDrain()
  f.send({ id: 2, method: 'pty.cancelDelivery' })
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  work.resolve()
  await drain
  await vi.waitFor(() =>
    expect(f.responses).toContainEqual(
      expect.objectContaining({ id: 2, result: expect.objectContaining({ canceled: true }) })
    )
  )
})
