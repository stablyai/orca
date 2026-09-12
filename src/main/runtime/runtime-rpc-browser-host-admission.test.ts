import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { defineStreamingMethod, type RpcRequest } from './rpc/core'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { withCurrentOrchestrationContract } from './runtime-rpc-test-harness'

const request = (method: string, params?: unknown): RpcRequest => ({
  id: method,
  authToken: 'test-token',
  method,
  params
})

describe('runtime RPC browser-host admission', () => {
  it('classifies host attachment for bounded disconnect-aware admission', () => {
    expect(classifyRuntimeLongPoll(request('browser.clientHost.attach'))).toBe('browser-host')
    expect(classifyRuntimeLongPoll(request('terminal.wait'))).toBe('wait')
    expect(classifyRuntimeLongPoll(request('orchestration.ask'))).toBe('ask')
    expect(classifyRuntimeLongPoll(request('orchestration.check', { wait: true }))).toBe('wait')
    expect(classifyRuntimeLongPoll(request('status.get'))).toBeNull()
  })

  it('reserves wait capacity and releases host admission on socket close', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-admission-'))
    const aborted = vi.fn()
    const blockingMethod = (name: 'browser.clientHost.attach' | 'terminal.wait') =>
      defineStreamingMethod({
        name,
        params: null,
        handler: async (_params, { signal }) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => {
                aborted(name)
                resolve()
              },
              { once: true }
            )
          })
        }
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 4,
      methods: [blockingMethod('browser.clientHost.attach'), blockingMethod('terminal.wait')]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'connection-a'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const socket = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, method: string) =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method, deviceToken: device.token }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const host = dispatch('host-a', 'browser.clientHost.attach')
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(1))
      await dispatch('host-overflow', 'browser.clientHost.attach')
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'host-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'browser-host capacity reached; retry with backoff'
          })
        })
      )

      const wait = dispatch('wait-a', 'terminal.wait')
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(2))

      socket.readyState = 3
      socket.emit('close')
      await Promise.all([host, wait])
      expect(server['activeLongPolls']).toBe(0)
      expect(server['activeBrowserHostLongPolls']).toBe(0)
      expect(aborted).toHaveBeenCalledWith('browser.clientHost.attach')
      expect(aborted).toHaveBeenCalledWith('terminal.wait')
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('reserves browser-host capacity for a second paired device', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-fairness-'))
    const blockingHost = defineStreamingMethod({
      name: 'browser.clientHost.attach',
      params: null,
      handler: async (_params, { signal }) =>
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
    })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 16,
      methods: [blockingHost]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const deviceA = server['deviceRegistry'].addDevice('runtime-a', 'runtime')
    const deviceB = server['deviceRegistry'].addDevice('runtime-b', 'runtime')
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const socketAReplacement = new FakeWebSocket()
    const connectionIds = new Map([
      [socketA, 'connection-a'],
      [socketB, 'connection-b'],
      [socketAReplacement, 'connection-a-replacement']
    ])
    server['mobileSocketWiring'] = {
      getConnectionId: (socket) => connectionIds.get(socket as unknown as FakeWebSocket)
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const repliesA: Record<string, unknown>[] = []
    const repliesB: Record<string, unknown>[] = []
    const dispatch = (
      id: string,
      deviceToken: string,
      socket: FakeWebSocket,
      replies: Record<string, unknown>[]
    ) =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method: 'browser.clientHost.attach', deviceToken }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const deviceAHosts = Array.from({ length: 4 }, (_, index) =>
        dispatch(`host-a-${index}`, deviceA.token, socketA, repliesA)
      )
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(4))

      await dispatch('host-a-overflow', deviceA.token, socketA, repliesA)
      expect(repliesA).toContainEqual(
        expect.objectContaining({
          id: 'host-a-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'browser-host capacity reached; retry with backoff'
          })
        })
      )

      const deviceBHost = dispatch('host-b', deviceB.token, socketB, repliesB)
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(5))
      expect(repliesB).toEqual([])

      socketA.readyState = 3
      socketA.emit('close')
      await Promise.all(deviceAHosts)
      expect(server['activeBrowserHostLongPolls']).toBe(1)

      const replacement = dispatch(
        'host-a-replacement',
        deviceA.token,
        socketAReplacement,
        repliesA
      )
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(2))

      socketAReplacement.readyState = 3
      socketAReplacement.emit('close')
      socketB.readyState = 3
      socketB.emit('close')
      await Promise.all([replacement, deviceBHost])
      expect(server['activeBrowserHostLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps a wait slot when asks and browser hosts fill their shared budget', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-wait-reserve-'))
    const blockingMethod = (
      name: 'browser.clientHost.attach' | 'orchestration.ask' | 'terminal.wait'
    ) =>
      defineStreamingMethod({
        name,
        params: null,
        handler: async (_params, { signal }) =>
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 4,
      methods: [
        blockingMethod('browser.clientHost.attach'),
        blockingMethod('orchestration.ask'),
        blockingMethod('terminal.wait')
      ]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const deviceA = server['deviceRegistry'].addDevice('runtime-a', 'runtime')
    const deviceB = server['deviceRegistry'].addDevice('runtime-b', 'runtime')
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, method: string, token: string, socket: FakeWebSocket) =>
      server['handleWebSocketMessage'](
        JSON.stringify(withCurrentOrchestrationContract({ id, method, deviceToken: token })),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const active = [
        dispatch('ask-a', 'orchestration.ask', deviceA.token, socketA),
        dispatch('ask-b', 'orchestration.ask', deviceA.token, socketA),
        dispatch('host-a', 'browser.clientHost.attach', deviceA.token, socketA)
      ]
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(3))

      const hostB = dispatch('host-b', 'browser.clientHost.attach', deviceB.token, socketB)
      await vi.waitFor(() =>
        expect(replies).toContainEqual(
          expect.objectContaining({
            id: 'host-b',
            ok: false,
            error: expect.objectContaining({
              message: 'browser-host capacity reached; retry with backoff'
            })
          })
        )
      )

      const wait = dispatch('wait-a', 'terminal.wait', deviceB.token, socketB)
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(4))

      socketA.readyState = 3
      socketA.emit('close')
      socketB.readyState = 3
      socketB.emit('close')
      await Promise.all([...active, hostB, wait])
      expect(server['activeLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}
