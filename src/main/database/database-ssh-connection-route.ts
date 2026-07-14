import { createServer } from 'node:net'
import type { DatabaseConnectionRequest } from '../../shared/database-types'
import type { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshPortForwardManager } from '../ssh/ssh-port-forward'

export type RoutedDatabaseConnection = {
  connection: DatabaseConnectionRequest['connection']
  close: () => Promise<void>
}

const MAX_PORT_ALLOCATION_ATTEMPTS = 3

type DatabaseSshConnectionRouteDependencies = {
  getConnectionManager: () => Promise<SshConnectionManager | null>
  getPortForwardManager: () => Promise<SshPortForwardManager | null>
  allocateLoopbackPort: () => Promise<number>
}

export class DatabaseSshConnectionRoute {
  private readonly dependencies: DatabaseSshConnectionRouteDependencies

  constructor(dependencies: Partial<DatabaseSshConnectionRouteDependencies> = {}) {
    this.dependencies = {
      // Why: ipc/ssh also imports the runtime RPC registry. Resolve its live
      // managers lazily so database method registration cannot form a cycle.
      getConnectionManager:
        dependencies.getConnectionManager ??
        (async () => (await import('../ipc/ssh')).getSshConnectionManager()),
      getPortForwardManager:
        dependencies.getPortForwardManager ??
        (async () => (await import('../ipc/ssh')).getSshPortForwardManager()),
      allocateLoopbackPort: dependencies.allocateLoopbackPort ?? allocateLoopbackPort
    }
  }

  async open(request: DatabaseConnectionRequest): Promise<RoutedDatabaseConnection> {
    if (request.execution?.kind !== 'ssh') {
      return { connection: request.connection, close: async () => {} }
    }

    const [connectionManager, portForwardManager] = await Promise.all([
      this.dependencies.getConnectionManager(),
      this.dependencies.getPortForwardManager()
    ])
    const sshConnection = connectionManager?.getConnection(request.execution.connectionId)
    if (!sshConnection || !portForwardManager) {
      throw new Error(
        `SSH connection "${request.execution.connectionId}" is not ready for database access`
      )
    }

    let forward: Awaited<ReturnType<SshPortForwardManager['addForward']>> | null = null
    for (let attempt = 1; attempt <= MAX_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
      const localPort = await this.dependencies.allocateLoopbackPort()
      try {
        forward = await portForwardManager.addForward(
          request.execution.connectionId,
          sshConnection,
          localPort,
          request.connection.host,
          request.connection.port,
          'Orca Database Query'
        )
        break
      } catch (error) {
        // Why: reserving and releasing an ephemeral port before the SSH
        // listener binds leaves a tiny race with other processes.
        if (attempt === MAX_PORT_ALLOCATION_ATTEMPTS || !isAddressInUseError(error)) {
          throw error
        }
      }
    }
    if (!forward) {
      throw new Error('Could not open the database SSH tunnel')
    }
    let closed = false
    return {
      connection: {
        ...request.connection,
        host: '127.0.0.1',
        port: forward.localPort,
        // Why: TLS verification must still authenticate the database hostname,
        // not the loopback listener introduced by the SSH tunnel.
        tlsServerName: request.connection.host
      },
      close: async () => {
        if (closed) {
          return
        }
        closed = true
        await portForwardManager.removeForwardAndWait(forward.id)
      }
    }
  }
}

function isAddressInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /EADDRINUSE|address already in use/i.test(message)
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port for the database SSH tunnel'))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}
