import { connect } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { browserTunnelTargetBlockReason } from '../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import { PairedPortForwardProvider } from './paired-port-forward-provider'
import type { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

function echoTunnel(opened: { host: string; port: number }[]): PairedPortForwardTunnel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider calls only open and isDisposed.
  return {
    isDisposed: () => false,
    open: async (target: { host: string; port: number }) => {
      opened.push(target)
      return new PassThrough()
    }
  } as unknown as PairedPortForwardTunnel
}

/** Answers only once the client has finished its request, as an HTTP/1.0 server does. */
function replyAfterRequestTunnel(): PairedPortForwardTunnel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider calls only open and isDisposed.
  return {
    isDisposed: () => false,
    open: async () => {
      const received: Buffer[] = []
      return new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          received.push(chunk)
          callback()
        },
        final(callback) {
          setTimeout(() => {
            this.push(Buffer.concat(received))
            this.push(null)
          }, 20)
          callback()
        }
      })
    }
  } as unknown as PairedPortForwardTunnel
}

function roundTrip(port: number, payload: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.write(payload))
    socket.once('data', (data) => {
      resolve(data.toString())
      socket.destroy()
    })
    socket.once('error', reject)
  })
}

describe('PairedPortForwardProvider', () => {
  it('listens on both loopbacks only, is fenced from paired tunnels, and frees the port on close', async () => {
    const opened: { host: string; port: number }[] = []
    const forward = await new PairedPortForwardProvider().start(echoTunnel(opened), {
      id: 'pf-1',
      connectionId: 'environment-a',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: 'localhost',
      remotePort: 5173
    })
    const port = forward.entry.localPort

    expect(await roundTrip(port, 'GET / HTTP/1.1\r\n\r\n')).toBe('GET / HTTP/1.1\r\n\r\n')
    // A browser tries [::1] first for localhost; that must reach the server too, not a local service.
    expect(await roundTrip(port, 'ipv6', '::1')).toBe('ipv6')
    expect(opened).toEqual([
      { host: 'localhost', port: 5173 },
      { host: 'localhost', port: 5173 }
    ])
    // Another paired client of this desktop must not chain through the forward to the server.
    expect(browserTunnelTargetBlockReason('127.0.0.1', port)).toBe('orca_listener')

    await forward.close()
    expect(browserTunnelTargetBlockReason('127.0.0.1', port)).toBeNull()
    await expect(roundTrip(port, 'x')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('still delivers the response after the client shuts down its request side', async () => {
    const forward = await new PairedPortForwardProvider().start(replyAfterRequestTunnel(), {
      id: 'pf-3',
      connectionId: 'environment-a',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: 'localhost',
      remotePort: 5173
    })
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        const socket = connect({ host: '127.0.0.1', port: forward.entry.localPort }, () =>
          socket.end('request')
        )
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.once('end', () => resolve(Buffer.concat(chunks).toString()))
        socket.once('error', reject)
      })
      expect(reply).toBe('request')
    } finally {
      await forward.close()
    }
  })

  it('never answers on a non-loopback address', async () => {
    const forward = await new PairedPortForwardProvider().start(echoTunnel([]), {
      id: 'pf-2',
      connectionId: 'environment-a',
      localHost: '127.0.0.1',
      localPort: 0,
      remoteHost: 'localhost',
      remotePort: 5173
    })
    try {
      const { networkInterfaces } = await import('node:os')
      const external = Object.values(networkInterfaces())
        .flat()
        .find((address) => address && address.family === 'IPv4' && !address.internal)
      if (external) {
        await expect(
          new Promise((resolve, reject) => {
            const socket = connect({ host: external.address, port: forward.entry.localPort })
            socket.once('connect', () => resolve('connected'))
            socket.once('error', reject)
          })
        ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
      }
    } finally {
      await forward.close()
    }
  })
})
