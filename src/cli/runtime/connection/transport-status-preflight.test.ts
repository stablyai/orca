import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { sendRequest } from './transport'

const { createConnection, nextId } = vi.hoisted(() => {
  let count = 0
  return { createConnection: vi.fn(), nextId: () => `id-${++count}` }
})
vi.mock('node:net', () => ({ createConnection }))
vi.mock('node:crypto', () => ({ randomUUID: nextId }))

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: 123,
  transports: [{ kind: 'unix', endpoint: 'test-only' }],
  authToken: 'token',
  startedAt: 1
}

class TestSocket extends EventEmitter {
  setEncoding = (): void => {}
  write = vi.fn((_frame: string): void => {})
  end = (): void => {}
  destroy = (): void => {}
}
let socket: TestSocket

beforeEach(() => {
  socket = new TestSocket()
  createConnection.mockReturnValue(socket)
})

afterEach(() => {
  vi.useRealTimers()
})

function frame(call: number): Record<string, unknown> {
  const written: unknown = JSON.parse(String(socket.write.mock.calls[call]?.[0]))
  return typeof written === 'object' && written !== null ? { ...written } : {}
}

describe('the status pre-request on the connection that carries a request', () => {
  it('carries none of the request’s orchestration fields', async () => {
    vi.useFakeTimers()
    const params = { type: 'worker_done', from: 'term_worker', subject: 'Done' }
    const envelope = { orchestrationRequestId: 'mutation_1', orchestrationCapability: 'test-proof' }
    const original = sendRequest(metadata, 'orchestration.send', params, 100, {
      ...envelope,
      orchestrationContractVersion: 1
    }).catch((error: unknown) => error)
    socket.emit('connect')
    const firstRequest = frame(0)
    expect(firstRequest).toMatchObject({
      method: 'orchestration.send',
      params,
      ...envelope,
      orchestrationContractVersion: 1
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(await original).toMatchObject({ code: 'runtime_timeout' })
    socket = new TestSocket()
    createConnection.mockReturnValue(socket)
    const pending = sendRequest(
      metadata,
      'orchestration.send',
      params,
      30_000,
      { ...envelope, orchestrationContractVersion: 2 },
      undefined,
      { requestSelection: { paramsForStatus: () => params } }
    )
    socket.emit('connect')
    const status = frame(0)
    expect(status).toMatchObject({ method: 'status.get' })
    expect(status).not.toHaveProperty('orchestrationContractVersion')
    expect(status).not.toHaveProperty('orchestrationRequestId')
    expect(status).not.toHaveProperty('orchestrationCapability')

    socket.emit(
      'data',
      `${JSON.stringify({ id: status.id, ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })}\n`
    )
    const request = frame(1)
    expect(request).toMatchObject({
      method: 'orchestration.send',
      params,
      ...envelope,
      orchestrationContractVersion: 2
    })
    expect(new Set([firstRequest.id, status.id, request.id]).size).toBe(3)
    socket.emit(
      'data',
      `${JSON.stringify({ id: request.id, ok: true, result: { sent: true }, _meta: { runtimeId: 'runtime-1' } })}\n`
    )
    await expect(pending).resolves.toMatchObject({ result: { sent: true } })
  })
})
