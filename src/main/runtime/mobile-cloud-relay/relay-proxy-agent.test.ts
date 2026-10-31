import { afterEach, describe, expect, it, vi } from 'vitest'

const constructed = vi.hoisted(() => {
  const list: { url: string; options: Record<string, unknown> }[] = []
  return list
})

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebSocket extends EventEmitter {
    constructor(url: string, options: Record<string, unknown>) {
      super()
      constructed.push({ url, options })
    }
    ping(): void {}
    send(): void {}
    close(): void {}
    terminate(): void {}
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket }
})

import { SocksProxyAgent } from 'socks-proxy-agent'
import { RelayControlClient } from './relay-control-client'
import { CloudRelayTransport } from '../rpc/relay-transport'

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
]

function startControlSocket(): void {
  const client = new RelayControlClient({
    cellUrl: 'https://cell.onorca.dev',
    relayJwt: 'jwt',
    relayHostId: 'host',
    assignmentEpoch: 1,
    identity: { userId: 'u', profileId: 'p', organizationId: 'o' },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy-agent tests never touch the keypair.
    keypair: {} as never,
    appVersion: '1.0.0',
    onConnectionOpen: vi.fn(),
    onDrain: vi.fn(),
    onClose: vi.fn()
  })
  void client.connect().catch(() => {})
}

async function startDataSocket(): Promise<void> {
  const transport = new CloudRelayTransport({
    cellUrl: 'https://cell.onorca.dev',
    relayHostId: 'AbCdEf0123_-xyZ9',
    generation: 1,
    onConnectionClosed: vi.fn()
  })
  await transport.start()
  void transport
    .openConnection({
      connId: 'c1',
      connTicket: 't',
      kind: 'resume',
      relayDeviceId: 'd',
      attachDeadlineMs: 10
    })
    .catch(() => {})
}

describe('relay sockets and proxy env', () => {
  afterEach(() => {
    constructed.length = 0
    vi.unstubAllEnvs()
  })

  function clearProxyEnv(): void {
    for (const name of PROXY_VARS) {
      vi.stubEnv(name, '')
    }
  }

  it('passes no agent to either relay socket when no proxy env is set', async () => {
    clearProxyEnv()
    startControlSocket()
    await startDataSocket()

    expect(constructed).toHaveLength(2)
    for (const { options } of constructed) {
      expect(options).not.toHaveProperty('agent')
    }
  })

  it('passes the proxy agent to both relay sockets when ALL_PROXY is socks5', async () => {
    clearProxyEnv()
    vi.stubEnv('ALL_PROXY', 'socks5://127.0.0.1:1080')
    startControlSocket()
    await startDataSocket()

    expect(constructed).toHaveLength(2)
    for (const { options } of constructed) {
      expect(options.agent).toBeInstanceOf(SocksProxyAgent)
    }
  })

  it('keeps relay sockets direct for NO_PROXY hosts', async () => {
    clearProxyEnv()
    vi.stubEnv('ALL_PROXY', 'socks5://127.0.0.1:1080')
    vi.stubEnv('NO_PROXY', '.onorca.dev')
    startControlSocket()
    await startDataSocket()

    expect(constructed).toHaveLength(2)
    for (const { options } of constructed) {
      expect(options).not.toHaveProperty('agent')
    }
  })
})
