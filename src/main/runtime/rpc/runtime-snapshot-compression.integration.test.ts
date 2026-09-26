import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketTransport } from './ws-transport'
import { E2EEChannel } from './e2ee-channel'
import { generateKeyPair, publicKeyToBase64 } from '../../../shared/e2ee-crypto'
import { createRuntimeSnapshotReply } from './runtime-snapshot-reply'
import { bandwidthSnapshot } from '../../../shared/remote-runtime-bandwidth-fixture'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime-subscription-transport'
import { RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY } from '../../../shared/remote-runtime-snapshot-compression'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function startHost(legacy = false, corrupt = false) {
  const keys = generateKeyPair()
  const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
  const channels = new Map<Parameters<typeof transport.setClientId>[0], E2EEChannel>()
  const frames: string[] = []
  const capabilities: string[][] = []
  let version = 1
  transport.onMessage((frame, _reply, ws) => {
    let channel = channels.get(ws)
    if (!channel) {
      channel = new E2EEChannel(ws, {
        serverSecretKey: keys.secretKey,
        resolveAuthenticatedDevice: (token) =>
          token === 'fixture-token'
            ? { deviceId: 'fixture', deviceToken: token, scope: 'runtime' }
            : null,
        onReady: (ready) => {
          transport.setClientId(ws, 'fixture')
          capabilities.push([...ready.clientCapabilities])
        },
        onError: (code, reason) => ws.close(code, reason)
      })
      const activeChannel = channel
      channel.onMessage((plaintext, reply) => {
        const request = JSON.parse(plaintext)
        const snapshotReply = createRuntimeSnapshotReply(
          request.method,
          'runtime',
          legacy ? [] : activeChannel.clientCapabilities,
          (response) => {
            frames.push(response)
            const parsed = JSON.parse(response)
            if (corrupt && parsed.compressedResult) {
              parsed.compressedResult.data = 'broken!'
            }
            reply(JSON.stringify(parsed))
          }
        )
        snapshotReply(
          JSON.stringify({
            id: request.id,
            ok: true,
            ...(request.method.startsWith('session.tabs.') ? { streaming: true } : {}),
            result: request.method.startsWith('session.tabs.')
              ? bandwidthSnapshot(version++)
              : { files: ['index.ts'] },
            _meta: { runtimeId: 'fixture' }
          })
        )
      })
      channels.set(ws, channel)
    }
    channel.handleRawMessage(frame)
  })
  transport.onConnectionClose((_id, ws) => {
    channels.get(ws)?.destroy()
    channels.delete(ws)
  })
  await transport.start()
  cleanups.push(async () => {
    for (const channel of channels.values()) {
      channel.destroy()
    }
    await transport.stop()
  })
  return {
    frames,
    capabilities,
    disconnect: () => {
      for (const socket of channels.keys()) {
        socket.terminate()
      }
    },
    pairing: {
      v: 2 as const,
      endpoint: `ws://127.0.0.1:${transport.resolvedPort}`,
      deviceToken: 'fixture-token',
      publicKeyB64: publicKeyToBase64(keys.publicKey)
    }
  }
}

describe('snapshot compression over authenticated WebSocket', () => {
  it.each([
    ['current peers', false, true, true],
    ['old host', true, true, false],
    ['old/non-advertising client', false, false, false]
  ] as const)('keeps %s interoperable', async (_name, legacy, enabled, compressed) => {
    const host = await startHost(legacy)
    const onResponse = vi.fn()
    const onError = vi.fn()
    const client = await subscribeRemoteRuntimeTransport(
      host.pairing,
      'session.tabs.subscribeAll',
      {},
      1000,
      { onResponse, onError },
      { snapshotCompression: enabled }
    )
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce())
    expect(onResponse.mock.calls[0]![0].result).toEqual(bandwidthSnapshot(1))
    expect(Boolean(JSON.parse(host.frames[0]!).compressedResult)).toBe(compressed)
    expect(host.capabilities[0]!.includes(RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY)).toBe(enabled)
    await expect(client.sendRequest!('files.list', {}, 1000)).resolves.toMatchObject({
      result: { files: ['index.ts'] }
    })
    expect(JSON.parse(host.frames[1]!).compressedResult).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
    client.close()
  })

  it('reconnects with an independent dictionary and the latest authoritative snapshot', async () => {
    const host = await startHost()
    const onResponse = vi.fn()
    const onClose = vi.fn()
    await subscribeRemoteRuntimeTransport(host.pairing, 'session.tabs.subscribeAll', {}, 1000, {
      onResponse,
      onClose,
      onError: vi.fn()
    })
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce())
    host.disconnect()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const second = await subscribeRemoteRuntimeTransport(
      host.pairing,
      'session.tabs.subscribeAll',
      {},
      1000,
      { onResponse, onError: vi.fn() }
    )
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledTimes(2))
    expect(onResponse.mock.calls[1]![0].result).toEqual(bandwidthSnapshot(2))
    second.close()
  })

  it('reports malformed compressed data and closes without a silent legacy retry', async () => {
    const host = await startHost(false, true)
    const onError = vi.fn()
    const onClose = vi.fn()
    const onResponse = vi.fn()
    await subscribeRemoteRuntimeTransport(host.pairing, 'session.tabs.subscribeAll', {}, 1000, {
      onResponse,
      onError,
      onClose
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_runtime_response' })
    )
    expect(onResponse).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    expect(host.capabilities).toHaveLength(1)
  })
})
