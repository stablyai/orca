import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  setupDaemonHandshake,
  runConnectHandshake,
  EXIT_CODE_VERSION_MISMATCH
} from './relay-handshake'
import {
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  FrameDecoder,
  type DecodedFrame,
  MessageType
} from './protocol'

// Why: --connect normally calls process.exit on mismatch / fatal handshake
// errors. Stub it for tests so the harness sees a thrown sentinel error
// rather than tearing down the test runner.
class ExitCalled extends Error {
  code: number
  constructor(code: number) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

describe('handshake round-trip over a real Socket pair', () => {
  let server: Server
  let sockPath: string
  let tmpDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>

  let uncaughtHandler: (err: Error) => void

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-handshake-test-'))
    sockPath = join(tmpDir, 'relay.sock')
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code ?? 0)
    }) as never)
    // Why: process.exit is called from inside async callbacks
    // (process.stderr.write flush callback) which would otherwise surface
    // as an uncaughtException after the test resolves and tear down the
    // runner. We swallow ExitCalled — exitSpy still records the call so
    // assertions hold.
    uncaughtHandler = (err: Error): void => {
      if (err instanceof ExitCalled) {
        return
      }
      throw err
    }
    process.on('uncaughtException', uncaughtHandler)
  })

  afterEach(async () => {
    process.off('uncaughtException', uncaughtHandler)
    exitSpy.mockRestore()
    for (const s of liveServerSockets) {
      s.destroy()
    }
    liveServerSockets.length = 0
    if (server) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const liveServerSockets: Socket[] = []
  function trackServerSocket(s: Socket): Socket {
    liveServerSockets.push(s)
    return s
  }

  function startDaemon(version: string): Promise<{
    accepted: Promise<{ sock: Socket; leftover: Buffer }>
  }> {
    return new Promise((resolve) => {
      const acceptedDeferred: {
        promise: Promise<{ sock: Socket; leftover: Buffer }>
        resolve: (v: { sock: Socket; leftover: Buffer }) => void
      } = (() => {
        let _resolve: (v: { sock: Socket; leftover: Buffer }) => void = () => {}
        const promise = new Promise<{ sock: Socket; leftover: Buffer }>((r) => {
          _resolve = r
        })
        return { promise, resolve: _resolve }
      })()

      server = createServer((sock) => {
        trackServerSocket(sock)
        setupDaemonHandshake(sock, {
          launchVersion: version,
          onAccepted: (s, leftover) => acceptedDeferred.resolve({ sock: s, leftover })
        })
      })
      server.listen(sockPath, () => resolve({ accepted: acceptedDeferred.promise }))
    })
  }

  it('accepts a matching version and delivers no leftover when the bridge sent only the handshake', async () => {
    const { accepted } = await startDaemon('0.1.0+match')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn<(leftover: Buffer) => void>()
    runConnectHandshake(bridgeSock, '0.1.0+match', { onAccepted: acceptedCb })

    const { leftover } = await accepted
    expect(leftover.length).toBe(0)

    await vi.waitFor(() => expect(acceptedCb).toHaveBeenCalledTimes(1))
    expect(acceptedCb.mock.calls[0][0].length).toBe(0)

    bridgeSock.destroy()
  })

  it('preserves leftover bytes on the daemon side when an extra frame is coalesced after the handshake', async () => {
    // Why: simulate an aggressive client that pipelines a frame immediately
    // after the handshake. We bypass runConnectHandshake here and write the
    // raw bytes directly so we control the coalescing behaviour.
    const { accepted } = await startDaemon('0.1.0+match')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const handshakeFrame = encodeHandshakeFrame({
      type: 'orca-relay-handshake',
      version: '0.1.0+match'
    })
    const trailingPayload = encodeJsonRpcFrame({ jsonrpc: '2.0', method: 'noop', params: {} }, 1, 0)
    bridgeSock.write(Buffer.concat([handshakeFrame, trailingPayload]))

    const { leftover } = await accepted

    const seen: DecodedFrame[] = []
    const dec = new FrameDecoder((f) => seen.push(f))
    dec.feed(leftover)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe(MessageType.Regular)

    bridgeSock.destroy()
  })

  it('preserves leftover bytes on the bridge side when the daemon coalesces handshake-ok + a JSON-RPC frame', async () => {
    let serverHandshakeSeen = false
    server = createServer((sock) => {
      trackServerSocket(sock)
      const decoder = new FrameDecoder((frame) => {
        if (frame.type !== MessageType.Handshake || serverHandshakeSeen) {
          return
        }
        serverHandshakeSeen = true
        const ok = encodeHandshakeFrame({
          type: 'orca-relay-handshake-ok',
          version: '0.1.0+match'
        })
        const trailing = encodeJsonRpcFrame(
          { jsonrpc: '2.0', method: 'pty.event', params: { evt: 'data' } },
          7,
          1
        )
        sock.write(Buffer.concat([ok, trailing]))
      })
      sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn<(leftover: Buffer) => void>()
    runConnectHandshake(bridgeSock, '0.1.0+match', { onAccepted: acceptedCb })

    await vi.waitFor(() => expect(acceptedCb).toHaveBeenCalledTimes(1))
    const leftover = acceptedCb.mock.calls[0][0]

    const seen: DecodedFrame[] = []
    const dec = new FrameDecoder((f) => seen.push(f))
    dec.feed(leftover)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe(MessageType.Regular)

    bridgeSock.destroy()
  })

  it('exits with EXIT_CODE_VERSION_MISMATCH when the daemon reports a mismatch', async () => {
    await startDaemon('0.1.0+server-version')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn()
    runConnectHandshake(bridgeSock, '0.1.0+different', { onAccepted: acceptedCb })

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_VERSION_MISMATCH)
    expect(acceptedCb).not.toHaveBeenCalled()

    bridgeSock.destroy()
  })

  it('does not call onAccepted before any handshake-ok frame arrives', async () => {
    // Why: silent server that never replies. acceptedCb must stay
    // un-invoked even though the bridge has flushed its handshake frame.
    server = createServer((sock) => {
      trackServerSocket(sock)
      /* swallow */
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn()
    runConnectHandshake(bridgeSock, '0.1.0+match', { onAccepted: acceptedCb })

    await new Promise((r) => setTimeout(r, 100))
    expect(acceptedCb).not.toHaveBeenCalled()

    bridgeSock.destroy()
  })
})
