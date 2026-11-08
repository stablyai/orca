import { createServer, type Server } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { installBestEffortSocketTypeOfService } from './best-effort-socket-type-of-service'

const nativeSetTypeOfService = Socket.prototype.setTypeOfService
let server: Server | null = null

afterEach(() => {
  Socket.prototype.setTypeOfService = nativeSetTypeOfService
  server?.close()
  server = null
})

describe('installBestEffortSocketTypeOfService', () => {
  it('lets fetch complete when the TOS syscall fails on its socket (STA-14317)', async () => {
    server = createServer((_request, response) => response.end('ok'))
    const listening = server
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    const address = listening.address()
    const port = typeof address === 'object' && address ? address.port : 0
    // macOS fails the syscall with EINVAL once the peer has reset the socket.
    Socket.prototype.setTypeOfService = function (): Socket {
      throw Object.assign(new Error('setTypeOfService EINVAL'), {
        code: 'EINVAL',
        syscall: 'setTypeOfService'
      })
    }

    installBestEffortSocketTypeOfService()

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5_000)
    })
    expect(await response.text()).toBe('ok')
  })
})
