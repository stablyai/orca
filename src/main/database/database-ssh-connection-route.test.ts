import { describe, expect, it, vi } from 'vitest'
import type { DatabaseConnectionRequest } from '../../shared/database-types'
import { DatabaseSshConnectionRoute } from './database-ssh-connection-route'

const request: DatabaseConnectionRequest = {
  connection: {
    providerId: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
    user: 'developer',
    sslMode: 'verify-full'
  },
  credential: { password: 'memory-only' },
  execution: { kind: 'ssh', connectionId: 'ssh-p8' }
}

describe('DatabaseSshConnectionRoute', () => {
  it('forwards the database endpoint through the project SSH connection', async () => {
    const sshConnection = { id: 'live-connection' }
    const addForward = vi.fn().mockResolvedValue({
      id: 'pf-db',
      connectionId: 'ssh-p8',
      localPort: 45_678,
      remoteHost: '127.0.0.1',
      remotePort: 5432
    })
    const removeForwardAndWait = vi.fn().mockResolvedValue(null)
    const route = new DatabaseSshConnectionRoute({
      getConnectionManager: async () =>
        ({ getConnection: vi.fn().mockReturnValue(sshConnection) }) as never,
      getPortForwardManager: async () => ({ addForward, removeForwardAndWait }) as never,
      allocateLoopbackPort: vi.fn().mockResolvedValue(45_678)
    })

    const routed = await route.open(request)

    expect(addForward).toHaveBeenCalledWith(
      'ssh-p8',
      sshConnection,
      45_678,
      '127.0.0.1',
      5432,
      'Orca Database Query'
    )
    expect(routed.connection).toEqual({
      ...request.connection,
      host: '127.0.0.1',
      port: 45_678,
      tlsServerName: '127.0.0.1'
    })
    await routed.close()
    await routed.close()
    expect(removeForwardAndWait).toHaveBeenCalledTimes(1)
    expect(removeForwardAndWait).toHaveBeenCalledWith('pf-db')
  })

  it('rejects SSH routing when the project connection is not active', async () => {
    const route = new DatabaseSshConnectionRoute({
      getConnectionManager: async () =>
        ({ getConnection: vi.fn().mockReturnValue(undefined) }) as never,
      getPortForwardManager: async () => ({}) as never,
      allocateLoopbackPort: vi.fn().mockResolvedValue(45_678)
    })

    await expect(route.open(request)).rejects.toThrow(
      'SSH connection "ssh-p8" is not ready for database access'
    )
  })

  it('retries when another process claims the allocated loopback port', async () => {
    const addForward = vi
      .fn()
      .mockRejectedValueOnce(new Error('listen EADDRINUSE: address already in use'))
      .mockResolvedValueOnce({ id: 'pf-db', localPort: 45_679 })
    const allocateLoopbackPort = vi.fn().mockResolvedValueOnce(45_678).mockResolvedValueOnce(45_679)
    const route = new DatabaseSshConnectionRoute({
      getConnectionManager: async () =>
        ({ getConnection: vi.fn().mockReturnValue({ id: 'live-connection' }) }) as never,
      getPortForwardManager: async () =>
        ({ addForward, removeForwardAndWait: vi.fn().mockResolvedValue(null) }) as never,
      allocateLoopbackPort
    })

    const routed = await route.open(request)

    expect(allocateLoopbackPort).toHaveBeenCalledTimes(2)
    expect(addForward).toHaveBeenCalledTimes(2)
    expect(routed.connection.port).toBe(45_679)
    await routed.close()
  })

  it('leaves non-SSH database connections unchanged', async () => {
    const route = new DatabaseSshConnectionRoute({
      getConnectionManager: vi.fn().mockResolvedValue(null),
      getPortForwardManager: vi.fn().mockResolvedValue(null),
      allocateLoopbackPort: vi.fn()
    })
    const localRequest = { ...request, execution: undefined }

    const routed = await route.open(localRequest)

    expect(routed.connection).toBe(localRequest.connection)
    await expect(routed.close()).resolves.toBeUndefined()
  })
})
