import { createServer, type Server } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { stopOrphanMock } = vi.hoisted(() => ({ stopOrphanMock: vi.fn() }))
vi.mock('./system-ssh-orphaned-forward', () => ({ stopOrphanedOrcaSshForward: stopOrphanMock }))

import { reserveLocalForwardPort } from './system-ssh-forward-port-reservation'

let holder: Server | null = null

async function holdPort(): Promise<number> {
  const server = createServer()
  holder = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

function release(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = holder
    holder = null
    if (!server) {
      resolve(false)
      return
    }
    server.close(() => resolve(true))
  })
}

beforeEach(() => {
  stopOrphanMock.mockReset().mockResolvedValue(false)
})

afterEach(async () => {
  await release()
})

describe('local forward port reservation', () => {
  it('asks the master only after the orphan sweep found nothing, then rebinds', async () => {
    const port = await holdPort()
    const cancel = vi.fn(release)
    await expect(reserveLocalForwardPort(port, ['ssh'], cancel)).resolves.toBe(port)
    expect(stopOrphanMock).toHaveBeenCalledWith(port, ['ssh'])
    expect(stopOrphanMock.mock.invocationCallOrder[0]).toBeLessThan(
      cancel.mock.invocationCallOrder[0]
    )
  })

  it('asks no master once the orphan sweep freed the port', async () => {
    const port = await holdPort()
    stopOrphanMock.mockImplementation(release)
    const cancel = vi.fn(async () => true)
    await expect(reserveLocalForwardPort(port, ['ssh'], cancel)).resolves.toBe(port)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps the bind error when neither recovery released the port', async () => {
    const port = await holdPort()
    await expect(reserveLocalForwardPort(port, ['ssh'], async () => false)).rejects.toThrow(
      `Local port 127.0.0.1:${port} is not available`
    )
  })

  it('tries no recovery for a port it cannot bind for any reason but use', async () => {
    const cancel = vi.fn(async () => true)
    await expect(reserveLocalForwardPort(-1, ['ssh'], cancel)).rejects.toThrow()
    expect(stopOrphanMock).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
})
