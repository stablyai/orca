import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createQuietWslHostStreamOpener } from '../ipc/wsl/wsl-host-agent-awake-wiring'
import { generateKeyPair } from '../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { subscribeRemoteRuntimeTransport } from '../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { WslHostAgentAwake } from './wsl-host-agent-awake'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

describe('WSL keep-awake stream teardown', () => {
  // The loopback handshake and socket shutdown have separate deadlines.
  it('closes a socket still waiting for the host to authenticate', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    let watcher: WslHostAgentAwake | undefined
    try {
      await once(server, 'listening', { signal: AbortSignal.timeout(3000) })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected a loopback TCP address')
      }
      const accepted: Promise<WebSocket> = once(server, 'connection', {
        signal: AbortSignal.timeout(3000)
      }).then(([peer]) => peer)
      watcher = new WslHostAgentAwake({
        listHosts: () => [{ environmentId: 'wsl-env', state: 'ready' }],
        onHostsChanged: () => () => {},
        openStream: createQuietWslHostStreamOpener({
          resolve: async () => ({
            endpoint: `ws://127.0.0.1:${address.port}`,
            hostPublicKeyB64: Buffer.from(generateKeyPair().publicKey).toString('base64'),
            credential: { kind: 'token', deviceToken: 'test-token' }
          }),
          isManuallyDisconnected: () => false,
          subscribe: subscribeRemoteRuntimeTransport
        }),
        report: () => {},
        now: Date.now
      })
      const peer = await accepted
      await once(peer, 'message', { signal: AbortSignal.timeout(3000) })
      const closed = once(peer, 'close', { signal: AbortSignal.timeout(3000) })
      watcher.dispose()
      await closed
      expect(peer.readyState).toBe(WebSocket.CLOSED)
    } finally {
      watcher?.dispose()
      for (const client of server.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)
})
