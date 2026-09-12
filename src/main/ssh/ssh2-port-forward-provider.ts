import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { startSocketPortForwardListener } from './socket-port-forward-listener'
import type { PortForwardStartOptions, SshPortForwardProvider } from './ssh-port-forward-provider'

export class Ssh2PortForwardProvider implements SshPortForwardProvider {
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() !== null
  }

  async start(conn: SshConnection, options: PortForwardStartOptions) {
    const client = conn.getClient()
    if (!client) {
      throw new Error('SSH connection is not established')
    }
    return startSocketPortForwardListener({
      forward: options,
      assertAdmission: options.assertAdmission,
      open: (socket) =>
        new Promise<ClientChannel>((resolve, reject) => {
          conn.forwardOut(
            client,
            socket,
            options.localHost,
            options.localPort,
            options.remoteHost,
            options.remotePort,
            (error, channel) => {
              if (error) {
                reject(error)
              } else {
                resolve(channel)
              }
            }
          )
        }),
      disposeDestination: (destination) => {
        try {
          ;(destination as ClientChannel).close()
        } catch {
          // Late SSH channel cleanup is best effort, never migration proof.
        }
      }
    })
  }
}
