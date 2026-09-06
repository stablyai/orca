import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocket, { WebSocketServer } from 'ws'
import '../../../config/scripts/vitest-host-ports-setup'
import { E2EEChannel } from '../../../src/main/runtime/rpc/e2ee-channel'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../../src/main/runtime/rpc/methods/terminal'
import {
  createOrderedInputPtyTestRig,
  inputProofDeadline
} from '../../../src/main/runtime/rpc/terminal-ordered-input-pty-test-rig'
import {
  decodeTerminalStreamFrame,
  type TerminalStreamFrame
} from '../../../src/shared/terminal-stream-protocol'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { MobileE2EEV2PhysicalChannel } from './mobile-e2ee-v2-physical-channel'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import {
  queueTerminalLiveMirrorSend,
  createTerminalLivePendingFlushState,
  waitForTerminalLivePendingFlush
} from '../terminal/terminal-live-pending-flush-state'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))

it.each(
  [300, 400, 500].flatMap((receiptDelayMs) => [
    { receiptDelayMs, pipeline: true },
    { receiptDelayMs, pipeline: false }
  ])
)(
  'encrypted real-PTY cadence: receipt delay $receiptDelayMs ms, pipeline $pipeline',
  async ({ receiptDelayMs, pipeline }) => {
    const payloads = ['BOM:\ufeff', 'abcdefghijklmnop', 'é'.repeat(9000), '\t\x1b[A\x7f\u0000']
    const suffix = '\r'
    const expected = Buffer.from(payloads.join('') + suffix)
    const rig = await createOrderedInputPtyTestRig(expected)
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
    const abort = new AbortController()
    const errors: unknown[] = []
    const sessions: E2EEChannel[] = []
    const dispatches: Promise<void>[] = []
    const delayedSends = new Set<ReturnType<typeof setTimeout>>()
    const keys = nacl.box.keyPair()
    const dispatcher = new RpcDispatcher({ runtime: rig.runtime, methods: TERMINAL_METHODS })
    let phone: WebSocket | undefined
    let mobile: MobileE2EEV2PhysicalChannel | undefined
    let disposeSubscription: (() => void) | undefined
    let clearStreams: (() => void) | undefined
    let delayReplies = false
    let receipts = 0
    let bytesBeforeFirstReceipt: Buffer | undefined
    const pending = createTerminalLivePendingFlushState()
    try {
      await inputProofDeadline(
        new Promise<void>((resolve, reject) => {
          server.once('listening', resolve)
          server.once('error', reject)
        }),
        'encrypted server listener'
      )
      server.on('connection', (socket) => {
        const channel = new E2EEChannel(socket, {
          serverSecretKey: keys.secretKey,
          resolveAuthenticatedDevice: (token) =>
            token === 'test-device'
              ? { deviceId: 'phone', deviceToken: token, scope: 'mobile' }
              : null,
          transportContext: { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' },
          requireV2: true,
          onReady: () => {},
          onError: (code, reason) => errors.push({ code, reason })
        })
        sessions.push(channel)
        channel.onMessage((plaintext, reply, sendBinary) => {
          const request = JSON.parse(plaintext)
          const dispatched = dispatcher.dispatchStreaming(request, reply, {
            connectionId: 'encrypted-input-proof',
            signal: abort.signal,
            clientKind: 'mobile',
            sendBinary: (bytes) => {
              if (!delayReplies) {
                return sendBinary(bytes)
              }
              const schedule = () => {
                const timer = setTimeout(() => {
                  delayedSends.delete(timer)
                  sendBinary(bytes)
                }, receiptDelayMs)
                delayedSends.add(timer)
              }
              schedule()
              return true
            },
            registerBinaryStreamHandler: (id, handler) => {
              handlers.set(id, handler)
              return () => {
                handlers.delete(id)
              }
            }
          })
          dispatches.push(dispatched)
          void dispatched.catch((error) => errors.push(error))
        })
        channel.onBinaryMessage((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame) {
            handlers.get(frame.streamId)?.(frame)
          }
        })
        socket.on('message', (raw, binary) =>
          channel.handleRawMessage(binary ? new Uint8Array(raw as Buffer) : raw.toString())
        )
        socket.on('error', (error) => errors.push(error))
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Missing encrypted listener port')
      }
      phone = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false })
      await inputProofDeadline(
        new Promise<void>((resolve, reject) => {
          phone!.once('open', resolve)
          phone!.once('error', reject)
        }),
        'encrypted client connection'
      )
      let authenticated!: () => void
      const ready = new Promise<void>((resolve) => {
        authenticated = resolve
      })
      let id = 0
      const streams = new MobileRelayRpcStreams({
        nextId: () => String(++id),
        waitForConnected: () => ready,
        sendFrame: (request) => mobile!.sendText(JSON.stringify(request)),
        sendBinary: (bytes) => mobile!.sendBinary(bytes)
      })
      clearStreams = () => streams.clear()
      mobile = new MobileE2EEV2PhysicalChannel({
        session: MobileE2EEV2ClientSession.create({
          desktopPublicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
          transport: 'relay',
          relayHostId: 'AbCdEf0123_-xyZ9'
        }),
        socket: phone,
        deviceToken: 'test-device',
        decodeBinary: async (raw) => (raw instanceof Uint8Array ? raw : null),
        onAuthenticated: authenticated,
        onText: (text) => {
          streams.handleResponse(JSON.parse(text))
        },
        onBinary: (bytes) => streams.handleBinary(bytes),
        onError: (error) => errors.push(error)
      })
      phone.on('message', (raw, binary) => {
        void mobile!.handleMessage(binary ? new Uint8Array(raw as Buffer) : raw.toString())
      })
      mobile.start()
      await inputProofDeadline(ready, 'real E2EE authentication')
      let subscribed!: () => void
      const subscriptionReady = new Promise<void>((resolve) => {
        subscribed = resolve
      })
      disposeSubscription = streams.subscribe(
        'terminal.subscribe',
        {
          terminal: 'terminal-1',
          client: { id: 'phone', type: 'mobile' },
          capabilities: { terminalBinaryStream: 1 }
        },
        (result) => {
          if ((result as { type?: string }).type === 'subscribed') {
            subscribed()
          }
        }
      )
      await inputProofDeadline(subscriptionReady, 'ordered-input negotiation')
      expect(streams.supportsTerminalStreamInput('terminal-1')).toBe(true)
      delayReplies = true
      const started = performance.now()
      const sender = (terminal: string, text: string) =>
        streams.sendTerminalStreamInput(terminal, text)!
      const sends: Promise<boolean>[] = []
      for (const text of payloads) {
        sends.push(
          queueTerminalLiveMirrorSend(pending, 'terminal-1', text, sender, { pipeline }).then(
            (accepted) => {
              bytesBeforeFirstReceipt ??= rig.bytes()
              receipts++
              return accepted
            }
          )
        )
        // Real-clock typing cadence, not a lifecycle readiness delay.
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
      expect(receipts).toBe(0)
      expect(
        await inputProofDeadline(waitForTerminalLivePendingFlush(pending), 'prefix receipts')
      ).toBe(true)
      expect(await Promise.all(sends)).toEqual(payloads.map(() => true))
      expect(bytesBeforeFirstReceipt).toEqual(
        Buffer.from(pipeline ? payloads.join('') : payloads[0]!)
      )
      expect(await inputProofDeadline(sender('terminal-1', suffix), 'control receipt')).toBe(true)
      await inputProofDeadline(rig.inputDelivered, 'real PTY bytes')
      expect(rig.bytes()).toEqual(expected)
      expect(errors).toEqual([])
      console.log(
        '[ordered-input-pty-proof]',
        JSON.stringify({
          payloads: payloads.length,
          bytes: expected.length,
          receiptDelayMs,
          pipeline,
          bytesBeforeFirstReceipt: bytesBeforeFirstReceipt!.length,
          firstPtyInputMs: Math.round(rig.firstInputAt()! - started),
          allReceiptsMs: Math.round(performance.now() - started)
        })
      )
      disposeSubscription()
      disposeSubscription = undefined
      streams.clear()
    } finally {
      disposeSubscription?.()
      clearStreams?.()
      abort.abort()
      for (const timer of delayedSends) {
        clearTimeout(timer)
      }
      mobile?.dispose()
      phone?.terminate()
      for (const channel of sessions) {
        channel.destroy()
      }
      for (const socket of server.clients) {
        socket.terminate()
      }
      await inputProofDeadline(Promise.allSettled(dispatches), 'host subscription cleanup')
      await inputProofDeadline(
        new Promise<void>((resolve) => server.close(() => resolve())),
        'encrypted server close'
      )
      await rig.close()
    }
  },
  20_000
)
