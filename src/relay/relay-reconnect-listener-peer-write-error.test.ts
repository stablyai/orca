import { afterEach, describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { RelayReconnectListener } from './relay-reconnect-listener'
import { RelaySocketOwnership } from './relay-socket-ownership'
import { encodeHandshakeFrame, FrameDecoder, RELAY_VERSION } from '../wsl-guest/protocol'
import { RelayDispatcher } from '../wsl-guest/dispatcher'
import type { PtyConsumerCloseCause } from '../shared/pty-consumer-session-contract'

// Why: on Windows named pipes a relay write can fail with EPIPE/ECONNRESET before EOF is read. The
// writer then closed the client as 'local', holding its PTY owner for the full grace.
describe.skipIf(process.platform === 'win32')('reconnect listener peer write error', () => {
  let dir: string
  let ownership: RelaySocketOwnership | null = null
  let dispatcher: RelayDispatcher | null = null
  let client: Socket | null = null

  afterEach(async () => {
    client?.destroy()
    client = null
    dispatcher?.dispose()
    dispatcher = null
    ownership?.closeAndCleanup()
    ownership = null
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  async function attachClient(): Promise<{
    serverSocket: Socket
    detached: PtyConsumerCloseCause[]
    relay: RelayDispatcher
  }> {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-peer-write-'))
    const sockPath = path.join(dir, 'relay.sock')
    ownership = new RelaySocketOwnership(sockPath)
    const relay = new RelayDispatcher(() => true)
    dispatcher = relay
    const detached: PtyConsumerCloseCause[] = []
    relay.onClientDetached((_id, cause) => detached.push(cause))
    const sockets: Socket[] = []
    const listen = ownership.listen.bind(ownership)
    ownership.listen = (onConnection) =>
      listen((socket) => {
        sockets.push(socket)
        onConnection(socket)
      })
    const listener = new RelayReconnectListener(relay, ownership, RELAY_VERSION, undefined, {
      detachPrimaryInput: () => {},
      cancelGrace: () => {},
      onLastClientClosed: () => {}
    })
    await listener.start()

    const peer = connect(sockPath)
    client = peer
    await new Promise<void>((resolve, reject) => {
      peer.once('connect', resolve)
      peer.once('error', reject)
    })
    await new Promise<void>((resolve) => {
      const decoder = new FrameDecoder(
        () => resolve(),
        () => resolve()
      )
      peer.on('data', (chunk: Buffer) => decoder.feed(chunk))
      peer.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version: RELAY_VERSION }))
    })
    expect(listener.clientCount).toBe(1)
    return { serverSocket: sockets[0], detached, relay }
  }

  // Why at the handle: pause() does not stop libuv reading, so EOF would win the race this test needs.
  // Leaving `_handle.reading` set keeps a later resume() from restarting reads.
  function stopReading(socket: Socket): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a connected net.Socket owns a libuv stream handle exposing readStop().
    const handle = (socket as unknown as { _handle: { readStop(): number } })._handle
    expect(handle.readStop()).toBe(0)
  }

  it('detaches as peer-closed when a write fails because the peer is gone', async () => {
    const { serverSocket, detached, relay } = await attachClient()
    stopReading(serverSocket)
    client?.destroy()
    client = null
    await new Promise((resolve) => setTimeout(resolve, 20))

    for (let frame = 0; frame < 200 && detached.length === 0; frame += 1) {
      relay.notifyControl('control.probe', { frame })
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    // EOF never reached the relay, so the write error was the only evidence the peer left.
    expect(serverSocket.readableEnded).toBe(false)
    expect(detached).toEqual(['peer-closed'])
  })

  it('detaches as peer-closed when a write lands after a peer reset destroyed the socket', async () => {
    const { serverSocket, detached, relay } = await attachClient()
    serverSocket.on('error', () => {})
    serverSocket.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))

    // Before 'close' runs: the listener has not detached the client yet.
    relay.notifyControl('control.probe', {})

    expect(detached).toEqual(['peer-closed'])
  })

  it('keeps a write after our own destroy a local close', async () => {
    const { serverSocket, detached, relay } = await attachClient()
    serverSocket.destroy()

    relay.notifyControl('control.probe', {})

    expect(detached).toEqual(['local'])
  })
})
