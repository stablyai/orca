import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { ForwardChannelOpenFailure } from './ssh-port-forward-provider'
import { checkForwardChannel } from './ssh-tcp-forwarding-probe'

import { lastChannelOpenFailure } from './system-ssh-port-forward-provider'

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
})
