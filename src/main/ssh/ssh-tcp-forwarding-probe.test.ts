import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { ForwardChannelOpenFailure } from './port-forwarding/ssh-port-forward-provider'
import { checkForwardChannel } from './ssh-tcp-forwarding-probe'

import { lastChannelOpenFailure } from './port-forwarding/system-ssh-port-forward-provider'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

/** Model ssh -L: socket behavior represents the remote channel-open result. */
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
})
