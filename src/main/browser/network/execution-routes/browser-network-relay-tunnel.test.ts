import { EventEmitter } from 'node:events'
import { createServer, connect, type Server } from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-stream-framing'
import { BrowserNetworkTunnelSession } from '../tunnels/browser-network-tunnel-session'
import {
  BROWSER_NETWORK_RELAY_FLOW_CONTROL,
  BROWSER_NETWORK_RELAY_WRITER_LIMITS
} from '../tunnels/browser-network-tunnel-stream-state'
import type { BrowserNetworkRelayChild } from './browser-network-relay-launch'
import { attachBrowserNetworkRelayTunnel } from './browser-network-relay-tunnel'

let sink: Server | undefined

afterEach(() => {
  sink?.close()
})

// The relay's end, wired as src/wsl-guest/wsl-browser-network-relay.ts wires it.
function relayOverPausablePipe() {
  const stdout = new PassThrough()
  const held: (() => void)[] = []
  let paused = false
  const relayWriter = new BrowserNetworkTunnelStreamFrameWriter(
    (bytes, callback) => stdout.write(bytes, callback),
    () => {},
    BROWSER_NETWORK_RELAY_WRITER_LIMITS
  )
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    flowControl: BROWSER_NETWORK_RELAY_FLOW_CONTROL,
    connect: (target) => connect({ ...target, allowHalfOpen: true }),
    sendBinary: (frame) => relayWriter.send(frame),
    onClose: () => {}
  })
  const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => session.handleBinary(frame),
    () => {}
  )
  // A slow SSH pipe: the desktop's writes complete only once the host reads them.
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const deliver = (): void => {
        decoder.feed(chunk)
        callback()
      }
      if (paused) {
        held.push(deliver)
      } else {
        deliver()
      }
    }
  })
  const child: BrowserNetworkRelayChild = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => {}
  })
  return {
    child,
    pause: () => {
      paused = true
    },
    heldWrites: () => held.length,
    resume: () => {
      paused = false
      for (const deliver of held.splice(0)) {
        deliver()
      }
    }
  }
}

it('keeps every stream alive while a slow pipe backs up many concurrent uploads', async () => {
  let received = 0
  sink = createServer((socket) => socket.on('data', (bytes: Buffer) => (received += bytes.length)))
  await new Promise<void>((resolve) => sink!.listen(0, '127.0.0.1', resolve))
  const address = sink.address()
  if (!address || typeof address === 'string') {
    throw new Error('sink did not bind')
  }
  const relay = relayOverPausablePipe()
  const tunnel = attachBrowserNetworkRelayTunnel(relay.child)
  const streams = await Promise.all(
    Array.from({ length: 8 }, () => tunnel.open({ host: '127.0.0.1', port: address.port }))
  )

  relay.pause()
  const upload = Buffer.alloc(1024 * 1024, 1)
  for (const stream of streams) {
    stream.write(upload)
  }
  await vi.waitFor(() => expect(relay.heldWrites()).toBeGreaterThan(0))
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(tunnel.isValid()).toBe(true)

  relay.resume()
  await vi.waitFor(() => expect(received).toBe(8 * upload.length), { timeout: 10_000 })
  expect(tunnel.isValid()).toBe(true)
  tunnel.close()
})
