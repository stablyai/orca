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

describe.skipIf(process.platform === 'win32')('reconnect listener peer end', () => {
  let dir: string
  let ownership: RelaySocketOwnership | null = null
  let dispatcher: RelayDispatcher | null = null

  afterEach(async () => {
    dispatcher?.dispose()
    dispatcher = null
    ownership?.closeAndCleanup()
    ownership = null
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  // Why: between the destroy on 'end' and 'close', a relay write fails and the dispatcher closes the
  // client as 'local', which holds its PTY owner for the full grace instead of the peer-closed floor.
  it('detaches the client as peer-closed before destroying an ended socket', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-peer-end-'))
    const sockPath = path.join(dir, 'relay.sock')
    ownership = new RelaySocketOwnership(sockPath)
    const detached: PtyConsumerCloseCause[] = []
    const relay = new RelayDispatcher(() => true)
    dispatcher = relay
    relay.onClientDetached((_id, cause) => detached.push(cause))
    const listen = ownership.listen.bind(ownership)
    const atServerEnd: { destroyed: boolean; detached: PtyConsumerCloseCause[] }[] = []
    ownership.listen = (onConnection) =>
      listen((socket) => {
        onConnection(socket)
        // Registered after the listener's own 'end' handler, so it observes what that handler did.
        socket.on('end', () =>
          atServerEnd.push({ destroyed: socket.destroyed, detached: [...detached] })
        )
      })
    const listener = new RelayReconnectListener(relay, ownership, RELAY_VERSION, undefined, {
      detachPrimaryInput: () => {},
      cancelGrace: () => {},
      onLastClientClosed: () => {}
    })
    await listener.start()

    const client: Socket = connect(sockPath)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    await new Promise<void>((resolve) => {
      const decoder = new FrameDecoder(
        () => resolve(),
        () => resolve()
      )
      client.on('data', (chunk: Buffer) => decoder.feed(chunk))
      client.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version: RELAY_VERSION }))
    })
    expect(listener.clientCount).toBe(1)

    client.end()
    await new Promise<void>((resolve) => {
      const poll = (): void => (listener.clientCount === 0 ? resolve() : void setTimeout(poll, 5))
      poll()
    })

    expect(atServerEnd).toEqual([{ destroyed: true, detached: ['peer-closed'] }])
    expect(detached).toEqual(['peer-closed'])
  })
})
