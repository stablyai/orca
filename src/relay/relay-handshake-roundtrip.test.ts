import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  setupDaemonHandshake,
  runConnectHandshake,
  EXIT_CODE_VERSION_MISMATCH
} from './relay-handshake'
import {
  encodeHandshakeFrame,
  encodeJsonRpcFrame,
  FrameDecoder,
  parseHandshakeMessage,
  MIN_RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  type DecodedFrame,
  type HandshakeMessage,
  MessageType
} from './protocol'
import { PTY_CONSUMER_SESSION_PROTOCOL_VERSION } from '../shared/pty-consumer-session-contract'
import { relayTestSocketPath } from './relay-test-socket-path'

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
    sockPath = relayTestSocketPath(tmpDir)
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

  function startDaemon(
    version: string,
    endpointCredential?: string
  ): Promise<{
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
          endpointCredential,
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

  it('rejects a same-build socket that lacks the detached endpoint credential', async () => {
    const { accepted } = await startDaemon('0.1.0+match', 'secret-credential')
    const bridgeSock = connect(sockPath)
    await new Promise<void>((resolve) => bridgeSock.once('connect', resolve))
    const closed = new Promise<void>((resolve) => bridgeSock.once('close', () => resolve()))

    runConnectHandshake(bridgeSock, '0.1.0+match', { onAccepted: vi.fn() }, 'wrong-credential')

    await closed
    await expect(
      Promise.race([
        accepted.then(() => 'accepted'),
        new Promise<string>((resolve) => setTimeout(() => resolve('closed'), 20))
      ])
    ).resolves.toBe('closed')
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

  // Reads the daemon's single handshake reply off a raw socket, so a test can assert what the
  // envelope carries rather than only whether the bridge accepted it.
  function readDaemonReply(sock: Socket): Promise<HandshakeMessage> {
    return new Promise((resolve) => {
      const decoder = new FrameDecoder((frame) => {
        if (frame.type === MessageType.Handshake) {
          resolve(parseHandshakeMessage(frame.payload))
        }
      })
      sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    })
  }

  it('refuses a cross-build bridge that offers no protocol range at all', async () => {
    // Why raw bytes: runConnectHandshake now always offers a range. Every relay already deployed
    // sends none, and for those the build hash stays the only gate — this is that fallback.
    await startDaemon('0.1.0+server-version')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))
    const reply = readDaemonReply(bridgeSock)

    bridgeSock.write(
      encodeHandshakeFrame({ type: 'orca-relay-handshake', version: '0.1.0+different' })
    )

    // The refusal now names the daemon's protocol version, which a content hash cannot express.
    await expect(reply).resolves.toMatchObject({
      type: 'orca-relay-handshake-mismatch',
      expected: '0.1.0+server-version',
      got: '0.1.0+different',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      minProtocolVersion: MIN_RELAY_PROTOCOL_VERSION
    })

    bridgeSock.destroy()
  })

  it('refuses a cross-build bridge whose offered range excludes this daemon', async () => {
    await startDaemon('0.1.0+server-version')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))
    const reply = readDaemonReply(bridgeSock)

    bridgeSock.write(
      encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        version: '0.1.0+different',
        protocolVersion: RELAY_PROTOCOL_VERSION + 5,
        minProtocolVersion: RELAY_PROTOCOL_VERSION + 5
      })
    )

    await expect(reply).resolves.toMatchObject({ type: 'orca-relay-handshake-mismatch' })

    bridgeSock.destroy()
  })

  it('exits with EXIT_CODE_VERSION_MISMATCH when the daemon reports a mismatch', async () => {
    server = createServer((sock) => {
      trackServerSocket(sock)
      const decoder = new FrameDecoder((frame) => {
        if (frame.type !== MessageType.Handshake) {
          return
        }
        sock.write(
          encodeHandshakeFrame({
            type: 'orca-relay-handshake-mismatch',
            expected: '0.1.0+server-version',
            got: '0.1.0+different',
            protocolVersion: RELAY_PROTOCOL_VERSION + 5,
            minProtocolVersion: RELAY_PROTOCOL_VERSION + 5
          })
        )
      })
      sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn()
    runConnectHandshake(bridgeSock, '0.1.0+different', { onAccepted: acceptedCb })

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_VERSION_MISMATCH)
    expect(acceptedCb).not.toHaveBeenCalled()

    bridgeSock.destroy()
  })

  // #13852: after an app update the client's bundle hashes differently, so the incumbent relay
  // holding every live PTY refused it and that work became permanently unreachable.
  it('admits a bridge from a different build once it offers a range this daemon falls in', async () => {
    const { accepted } = await startDaemon('0.1.0+incumbent-holding-live-ptys')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))

    const acceptedCb = vi.fn<(leftover: Buffer) => void>()
    runConnectHandshake(bridgeSock, '0.1.0+freshly-updated-client', { onAccepted: acceptedCb })

    await accepted
    await vi.waitFor(() => expect(acceptedCb).toHaveBeenCalledTimes(1))
    expect(exitSpy).not.toHaveBeenCalled()

    bridgeSock.destroy()
  })

  it('answers a cross-build bridge with the protocol version and capabilities it must speak', async () => {
    await startDaemon('0.1.0+incumbent-holding-live-ptys')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))
    const reply = readDaemonReply(bridgeSock)

    bridgeSock.write(
      encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        version: '0.1.0+freshly-updated-client',
        protocolVersion: RELAY_PROTOCOL_VERSION + 3,
        minProtocolVersion: MIN_RELAY_PROTOCOL_VERSION
      })
    )

    await expect(reply).resolves.toMatchObject({
      type: 'orca-relay-handshake-ok',
      // The build the client actually reached, which is no longer its own.
      version: '0.1.0+incumbent-holding-live-ptys',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      minProtocolVersion: MIN_RELAY_PROTOCOL_VERSION,
      capabilities: { ptyConsumerSession: PTY_CONSUMER_SESSION_PROTOCOL_VERSION }
    })

    bridgeSock.destroy()
  })

  // The refusal path logs the peer's claim, and `JSON.parse` yields objects a template literal
  // cannot stringify. A throw there is inside the frame-decoder callback, so it would kill the
  // daemon — and every PTY it still holds — on an unauthenticated frame.
  it('refuses a hostile protocolVersion claim without taking the daemon down', async () => {
    const { accepted } = await startDaemon('0.1.0+server-version')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))
    const reply = readDaemonReply(bridgeSock)

    bridgeSock.write(
      encodeHandshakeFrame(
        JSON.parse(
          '{"type":"orca-relay-handshake","version":"0.1.0+different","protocolVersion":{"toString":1}}'
        ) as HandshakeMessage
      )
    )

    await expect(reply).resolves.toMatchObject({ type: 'orca-relay-handshake-mismatch' })

    // Still serving: a second, well-formed client is admitted after the hostile one.
    const good = connect(sockPath)
    await new Promise<void>((r) => good.once('connect', () => r()))
    runConnectHandshake(good, '0.1.0+server-version', { onAccepted: vi.fn() })
    await accepted

    bridgeSock.destroy()
    good.destroy()
  })

  // Tolerance replaces a compatibility gate, never the auth gate: the credential file lives inside
  // the incumbent's own install dir, so presenting it is what proves the caller may reach it.
  it('still refuses a cross-build bridge that cannot present the endpoint credential', async () => {
    const { accepted } = await startDaemon('0.1.0+incumbent', 'secret-credential')

    const bridgeSock = connect(sockPath)
    await new Promise<void>((r) => bridgeSock.once('connect', () => r()))
    const closed = new Promise<void>((r) => bridgeSock.once('close', () => r()))

    runConnectHandshake(
      bridgeSock,
      '0.1.0+freshly-updated-client',
      { onAccepted: vi.fn() },
      'wrong-credential'
    )

    await closed
    await expect(
      Promise.race([
        accepted.then(() => 'accepted'),
        new Promise<string>((r) => setTimeout(() => r('closed'), 20))
      ])
    ).resolves.toBe('closed')
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

  // The daemon reads one handshake frame before any credential check, so every field on it is
  // untrusted input. `JSON.parse` hands back objects a template literal cannot stringify, and the
  // frame callback runs inside the decoder: a throw there used to escape the socket's data
  // handler and take the daemon — and every PTY and agent session it held — down with it.
  it('closes a connection whose handshake version is not a string and keeps serving', async () => {
    const { accepted } = await startDaemon('0.1.0+server-version')

    const hostile = connect(sockPath)
    await new Promise<void>((r) => hostile.once('connect', () => r()))
    const hostileClosed = new Promise<void>((r) => hostile.once('close', () => r()))
    hostile.write(
      encodeHandshakeFrame(
        JSON.parse('{"type":"orca-relay-handshake","version":{"toString":1}}') as HandshakeMessage
      )
    )
    await hostileClosed

    const good = connect(sockPath)
    await new Promise<void>((r) => good.once('connect', () => r()))
    const acceptedCb = vi.fn<(leftover: Buffer) => void>()
    runConnectHandshake(good, '0.1.0+server-version', { onAccepted: acceptedCb })
    await accepted
    await vi.waitFor(() => expect(acceptedCb).toHaveBeenCalledTimes(1))

    good.destroy()
  })

  // Same class, different instance: `onAccepted` runs inside the frame callback too, so a throw
  // from the accept path must cost that one connection and nothing else.
  it('closes only the connection whose accept path throws', async () => {
    let connections = 0
    const acceptedSockets: Socket[] = []
    server = createServer((sock) => {
      trackServerSocket(sock)
      connections += 1
      const failThisOne = connections === 1
      setupDaemonHandshake(sock, {
        launchVersion: '0.1.0+server-version',
        onAccepted: (s) => {
          if (failThisOne) {
            throw new Error('accept path failed')
          }
          acceptedSockets.push(s)
        }
      })
    })
    await new Promise<void>((r) => server.listen(sockPath, () => r()))

    const first = connect(sockPath)
    await new Promise<void>((r) => first.once('connect', () => r()))
    const firstClosed = new Promise<void>((r) => first.once('close', () => r()))
    runConnectHandshake(first, '0.1.0+server-version', { onAccepted: vi.fn() })
    await firstClosed

    const second = connect(sockPath)
    await new Promise<void>((r) => second.once('connect', () => r()))
    const acceptedCb = vi.fn<(leftover: Buffer) => void>()
    runConnectHandshake(second, '0.1.0+server-version', { onAccepted: acceptedCb })
    await vi.waitFor(() => expect(acceptedCb).toHaveBeenCalledTimes(1))
    expect(acceptedSockets).toHaveLength(1)

    second.destroy()
  })
})
