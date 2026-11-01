import '../unused-default-rpc-methods.test-fixture'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../../../shared/browser-network-tunnel-protocol'
import { browserNetworkExecutionHostKey } from '../../../browser/browser-network-execution-route'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { MOBILE_BROWSER_TUNNEL_METHODS } from './mobile-browser-network-tunnel'

const NATIVE_HOST_KEY = browserNetworkExecutionHostKey({
  kind: 'native',
  runtimeId: 'runtime-a',
  revision: 1
})

function runtime(
  resolution: unknown = { status: 'resolved', executionHostKey: NATIVE_HOST_KEY }
): OrcaRuntimeService {
  const cleanups = new Map<string, () => void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel method reads only these runtime members.
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => cleanups.get(id)?.(),
    resolveBrowserExecutionHostKeyForWorkspace: vi.fn(async () => resolution)
  } as unknown as OrcaRuntimeService
}

const request = {
  id: 'mobile-tunnel',
  authToken: 'bound-by-websocket',
  method: 'network.mobileBrowserTunnel',
  params: { workspaceId: 'workspace-a' }
}

const ReadyReply = z.object({
  result: z.object({
    type: z.literal('ready'),
    tunnelGeneration: z.number(),
    subscriptionId: z.string()
  })
})

function readyResult(reply: unknown) {
  const parsed = ReadyReply.safeParse(reply)
  return parsed.success ? parsed.data.result : null
}

function readyGeneration(reply: unknown): number | null {
  return readyResult(reply)?.tunnelGeneration ?? null
}

type PhoneSocket = {
  replies: unknown[]
  frames: BrowserNetworkTunnelFrame[]
  send: (frame: Omit<BrowserNetworkTunnelFrame, 'tunnelGeneration'>) => void
  generation: () => number
  done: Promise<void>
  close: () => void
}

function connectPhone(
  hostRuntime: OrcaRuntimeService,
  clientKind: 'mobile' | 'runtime' = 'mobile'
) {
  const dispatcher = new RpcDispatcher({
    runtime: hostRuntime,
    methods: MOBILE_BROWSER_TUNNEL_METHODS
  })
  const abort = new AbortController()
  let deliver: ((bytes: Uint8Array) => void) | null = null
  const phone: PhoneSocket = {
    replies: [],
    frames: [],
    send: (frame) =>
      deliver?.(
        encodeBrowserNetworkTunnelFrame({ ...frame, tunnelGeneration: phone.generation() })
      ),
    generation: () => {
      const ready = phone.replies.map(readyGeneration).find((generation) => generation !== null)
      if (ready === undefined) {
        throw new Error('tunnel not ready')
      }
      return ready
    },
    done: Promise.resolve(),
    close: () => abort.abort()
  }
  phone.done = dispatcher.dispatchStreaming(
    request,
    (reply) => phone.replies.push(JSON.parse(reply)),
    {
      connectionId: 'phone-connection',
      clientKind,
      pairedDeviceId: 'phone-a',
      signal: abort.signal,
      sendBinary: (bytes) => {
        const frame = decodeBrowserNetworkTunnelFrame(bytes)
        if (frame) {
          phone.frames.push(frame)
        }
        return true
      },
      registerBrowserTunnelFrameHandler: (handler) => {
        deliver = handler
        return () => (deliver = null)
      }
    }
  )
  return phone
}

let echoServer: Server | null = null

afterEach(() => {
  echoServer?.close()
  echoServer = null
})

async function startEchoServer(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket))
  echoServer = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('echo server has no port')
  }
  return address.port
}

function frameWith(phone: PhoneSocket, opcode: BrowserNetworkTunnelOpcode) {
  return phone.frames.find((frame) => frame.opcode === opcode)
}

describe('network.mobileBrowserTunnel RPC', () => {
  it('carries a phone page connection to a host port and back', async () => {
    const port = await startEchoServer()
    const phone = connectPhone(runtime())
    await vi.waitFor(() => expect(phone.generation()).toBeGreaterThan(0))

    phone.send({
      opcode: BrowserNetworkTunnelOpcode.Open,
      streamId: 1,
      payload: encodeBrowserNetworkTunnelOpen({ host: '127.0.0.1', port })
    })
    await vi.waitFor(() =>
      expect(frameWith(phone, BrowserNetworkTunnelOpcode.Opened)).toBeDefined()
    )
    phone.send({
      opcode: BrowserNetworkTunnelOpcode.WindowUpdate,
      streamId: 1,
      payload: encodeBrowserNetworkTunnelWindowUpdate(256 * 1024)
    })
    phone.send({
      opcode: BrowserNetworkTunnelOpcode.Data,
      streamId: 1,
      payload: new TextEncoder().encode('hello')
    })
    await vi.waitFor(() => {
      const data = frameWith(phone, BrowserNetworkTunnelOpcode.Data)
      expect(data && new TextDecoder().decode(data.payload)).toBe('hello')
    })

    phone.close()
    await phone.done
  })

  it('refuses ports a browser would block', async () => {
    const phone = connectPhone(runtime())
    await vi.waitFor(() => expect(phone.generation()).toBeGreaterThan(0))

    phone.send({
      opcode: BrowserNetworkTunnelOpcode.Open,
      streamId: 1,
      payload: encodeBrowserNetworkTunnelOpen({ host: '127.0.0.1', port: 22 })
    })
    await vi.waitFor(() => {
      const error = frameWith(phone, BrowserNetworkTunnelOpcode.Error)
      expect(error && new TextDecoder().decode(error.payload)).toBe('destination_connect_failed')
    })

    phone.close()
    await phone.done
  })

  it('ends the tunnel when the phone unsubscribes', async () => {
    const hostRuntime = runtime()
    const phone = connectPhone(hostRuntime)
    await vi.waitFor(() => expect(phone.generation()).toBeGreaterThan(0))
    const subscriptionId = phone.replies.map(readyResult).find(Boolean)?.subscriptionId
    expect(subscriptionId).toMatch(/^mobile-browser-tunnel:/)

    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: MOBILE_BROWSER_TUNNEL_METHODS
    })
    await dispatcher.dispatch({
      id: 'unsubscribe',
      authToken: 'bound-by-websocket',
      method: 'network.mobileBrowserTunnel.unsubscribe',
      params: { subscriptionId }
    })
    await phone.done
  })

  it('serves only phones', async () => {
    const phone = connectPhone(runtime(), 'runtime')
    await phone.done
    expect(phone.replies).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'authenticated_phone_browser_tunnel_required' })
      })
    ])
  })

  it('fails when the workspace network is unavailable', async () => {
    const phone = connectPhone(runtime({ status: 'unavailable' }))
    await phone.done
    expect(phone.replies).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_execution_host_unavailable' })
      })
    ])
  })
})
