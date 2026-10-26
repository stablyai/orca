import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT } from './browser-screencast-ghost-subscriber-eviction'
import { SCREENCAST_PENDING_FRAME_RETRY_MS } from './browser-screencast-subscriber-frame-delivery'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from './single-page-browser-commands-host-test-double'
import { E2EEChannel } from './rpc/e2ee-channel'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair
} from '../../shared/e2ee-crypto'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

function connectLegacyChannel() {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const sent: (string | Buffer)[] = []
  const ws = {
    OPEN: 1 as const,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: string | Buffer) => sent.push(data)),
    close: vi.fn()
  }
  const onError = vi.fn()
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    resolveAuthenticatedDevice: (token) =>
      token === 'valid-token'
        ? {
            deviceId: 'device-1',
            deviceToken: token,
            scope: 'mobile',
            clientId: token,
            callerFingerprint: 'test-fingerprint',
            credentialRevision: 0
          }
        : null,
    onReady: vi.fn(),
    onError
  })
  const sharedKey = deriveSharedKey(clientKeys.secretKey, serverKeys.publicKey)
  channel.handleRawMessage(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64')
    })
  )
  channel.handleRawMessage(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
  )
  let reply!: (response: string) => void
  let sendBinary!: RpcBinarySender
  channel.onMessage((_plaintext, textReply, binaryReply) => {
    reply = textReply
    sendBinary = binaryReply
  })
  channel.handleRawMessage(encrypt('{"id":"s","method":"browser.screencast"}', sharedKey))
  const decode = (frame: string | Buffer): string =>
    typeof frame === 'string'
      ? decrypt(frame, sharedKey)!
      : `binary:${Buffer.from(decryptBytes(new Uint8Array(frame), sharedKey)!).join(',')}`
  return { ws, sent, onError, reply, sendBinary, decode, channel }
}

async function subscribe(sendBinary: RpcBinarySender) {
  const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const stop = vi.fn(() => resolveDone())
  startBrowserScreencast.mockResolvedValue({ stop, done, updateViewport: vi.fn(async () => {}) })
  const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
  const subscription = await commands.browserScreencast(
    { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
    { sendBinary }
  )
  const onFrame: (bytes: Uint8Array<ArrayBufferLike>) => unknown =
    startBrowserScreencast.mock.calls[0][1].onFrame
  return { subscription, onFrame, stop }
}

describe('screencast over a backlogged legacy E2EE socket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Backlogged sockets remain live; ghost eviction would blank working phones.
  it('keeps the viewer through a long backlog and then delivers only the newest frame', async () => {
    const transport = connectLegacyChannel()
    const { subscription, onFrame, stop } = await subscribe(transport.sendBinary)
    onFrame(new Uint8Array([0]))
    const baseline = transport.sent.length

    transport.ws.bufferedAmount = 9 * 1024 * 1024
    transport.reply('{"parked":true}')
    const frameCount = BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT + 10
    for (let frame = 1; frame <= frameCount; frame++) {
      onFrame(new Uint8Array([frame]))
    }
    expect(stop).not.toHaveBeenCalled()
    expect(transport.sent.length).toBe(baseline)

    transport.ws.bufferedAmount = 0
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 2)
    expect(transport.sent.slice(baseline).map(transport.decode)).toEqual([
      '{"parked":true}',
      `binary:${frameCount}`
    ])
    expect(transport.onError).not.toHaveBeenCalled()
    subscription.session.stop()
    transport.channel.destroy()
  })
})
