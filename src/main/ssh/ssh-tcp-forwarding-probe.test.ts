import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForwardChannelOpenFailure } from './port-forwarding/ssh-port-forward-provider'
import { checkForwardChannel, probeTcpForwarding } from './ssh-tcp-forwarding-probe'
import { lastChannelOpenFailure } from './port-forwarding/system-ssh-port-forward-provider'

type OpenCallback = (error: (Error & { reason?: number }) | undefined, channel?: unknown) => void

function connectionAnswering(answer: (callback: OpenCallback) => void) {
  const forwardOut = vi.fn((_srcHost, _srcPort, _host, _port, callback: OpenCallback) =>
    answer(callback)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe calls only forwardOut on the client.
  return { forwardOut, connection: { getClient: () => ({ forwardOut }) as never } }
}

function openFailure(reason: number): Error & { reason: number } {
  return Object.assign(new Error('open failed'), { reason })
}

describe('TCP forwarding probe', () => {
  it('reads an administrative refusal as forwarding refused', async () => {
    const { connection } = connectionAnswering((callback) => callback(openFailure(1)))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('refused')
  })

  it('reads a connect failure as allowed: sshd tried, nothing listened yet', async () => {
    const { connection, forwardOut } = connectionAnswering((callback) => callback(openFailure(2)))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('allowed')
    expect(forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '127.0.0.1', 6768, expect.any(Function))
  })

  it('closes an opened channel and reads it as allowed', async () => {
    const channel = { close: vi.fn() }
    const { connection } = connectionAnswering((callback) => callback(undefined, channel))
    await expect(probeTcpForwarding(connection, 6768)).resolves.toBe('allowed')
    expect(channel.close).toHaveBeenCalled()
  })

  it('is unverifiable without an ssh2 client, on a throw, or with no answer', async () => {
    await expect(probeTcpForwarding({ getClient: () => null }, 6768)).resolves.toBe('unverifiable')
    const throwing = connectionAnswering(() => {
      throw new Error('Not connected')
    })
    await expect(probeTcpForwarding(throwing.connection, 6768)).resolves.toBe('unverifiable')
    const silent = connectionAnswering(() => {})
    await expect(probeTcpForwarding(silent.connection, 6768, 5)).resolves.toBe('unverifiable')
  })
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

/** Stands in for `ssh -L`'s listener: the socket handler plays what the channel open did. */
async function forwardAnswering(
  onSocket: (socket: Socket, log: (line: string) => void) => void
): Promise<Parameters<typeof checkForwardChannel>[0]> {
  let stderr = ''
  const server = createServer((socket) => {
    socket.on('error', () => {})
    onSocket(socket, (line) => {
      stderr += `${line}\n`
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const localPort = typeof address === 'object' && address ? address.port : 0
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only localPort.
    entry: { localPort } as never,
    lastChannelOpenFailure: (): ForwardChannelOpenFailure | null => lastChannelOpenFailure(stderr)
  }
}

describe('forward channel check (system SSH)', () => {
  it('reads OpenSSH’s administrative refusal as refused, though its listener accepted', async () => {
    const forward = await forwardAnswering((socket, log) => {
      log('channel 1: open failed: administratively prohibited: open failed')
      socket.destroy()
    })
    await expect(checkForwardChannel(forward)).resolves.toBe('refused')
  })

  it('waits briefly for a refusal logged after the socket dropped', async () => {
    const forward = await forwardAnswering((socket, log) => {
      socket.destroy()
      setTimeout(() => log('channel 1: open failed: administratively prohibited: open failed'), 50)
    })
    await expect(checkForwardChannel(forward)).resolves.toBe('refused')
  })

  it('reads a connect failure as allowed: sshd dialled, nothing listened yet', async () => {
    const forward = await forwardAnswering((socket, log) => {
      log('channel 1: open failed: connect failed: Connection refused')
      socket.destroy()
    })
    await expect(checkForwardChannel(forward)).resolves.toBe('allowed')
  })

  it('reads reply bytes through the channel as allowed', async () => {
    const forward = await forwardAnswering((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
    })
    await expect(checkForwardChannel(forward)).resolves.toBe('allowed')
  })

  it('is unverifiable for an unexplained drop, a silent open channel, or no channel log', async () => {
    const dropped = await forwardAnswering((socket) => socket.destroy())
    await expect(checkForwardChannel(dropped)).resolves.toBe('unverifiable')
    const silent = await forwardAnswering((socket) => socket.resume())
    await expect(checkForwardChannel(silent, 50)).resolves.toBe('unverifiable')
    await expect(checkForwardChannel({ entry: dropped.entry })).resolves.toBe('unverifiable')
  })

  // Why: a forward still waiting on its own login (a key touch, a prompt) never binds its listener.
  it('reports a listener that never came up as not listening', async () => {
    const closed = await forwardAnswering(() => {})
    await new Promise((resolve) => servers.pop()?.close(resolve))
    await expect(checkForwardChannel(closed, 300)).resolves.toBe('not-listening')
  })

  it('reads the last channel failure OpenSSH logged', () => {
    expect(lastChannelOpenFailure('Warning: Permanently added host\n')).toBeNull()
    expect(
      lastChannelOpenFailure(
        'channel 1: open failed: connect failed: Connection refused\n' +
          'channel 2: open failed: administratively prohibited: open failed\n'
      )
    ).toBe('administratively-prohibited')
  })
})
