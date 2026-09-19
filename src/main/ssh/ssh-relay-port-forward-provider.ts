import type { SshConnection } from './ssh-connection'
import { openRegisteredSshNetworkTunnel } from './ssh-target-registry'
import { startSocketPortForwardListener } from './socket-port-forward-listener'
import type { PortForwardStartOptions, SshPortForwardProvider } from './ssh-port-forward-provider'

export class SshRelayPortForwardProvider implements SshPortForwardProvider {
  constructor(private readonly openTunnel = openRegisteredSshNetworkTunnel) {}

  canHandle(connection: SshConnection): boolean {
    return connection.getState().status === 'connected'
  }

  async start(connection: SshConnection, options: PortForwardStartOptions) {
    options.assertAdmission?.()
    const opened = await this.openTunnel(options.connectionId)
    let listener: Awaited<ReturnType<typeof startSocketPortForwardListener>>
    const assertAdmission = () => {
      options.assertAdmission?.()
      if (opened.connection !== connection) {
        throw new Error('ssh_port_forward_connection_changed')
      }
      opened.assertAdmission()
    }
    try {
      assertAdmission()
      listener = await startSocketPortForwardListener({
        forward: options,
        assertAdmission,
        open: () => opened.tunnel.open({ host: options.remoteHost, port: options.remotePort }),
        disposeDestination: (destination) => destination.destroy()
      })
    } catch (error) {
      try {
        await opened.release(new AbortController().signal)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'ssh_port_forward_start_cleanup_unverifiable'
        )
      }
      throw error
    }
    let closing: Promise<void> | undefined
    let localCloseProof: ReturnType<typeof listener.fenceForDrain> | undefined
    const close = () => {
      closing ??= (async () => {
        await listener.close()
        await opened.release(new AbortController().signal)
        localCloseProof = listener.fenceForDrain()
      })()
      return closing
    }
    return {
      entry: listener.entry,
      supportsResetRetirement: true as const,
      close,
      get retirementConfirmed(): boolean {
        if (!localCloseProof || !opened.tunnel.retirementConfirmed) {
          return false
        }
        try {
          localCloseProof.assertDrained()
          return true
        } catch {
          return false
        }
      },
      get resetRetirementConfirmed() {
        if (!localCloseProof || !opened.tunnel.resetRetirementRequest) {
          return undefined
        }
        try {
          localCloseProof.assertDrained()
          return opened.tunnel.resetRetirementRequest
        } catch {
          return undefined
        }
      },
      dispose: () => {
        void close().catch(() => {})
      },
      fenceForDrain: () => {
        const local = listener.fenceForDrain()
        const remote = opened.tunnel.fenceForDrain()
        const assertDrained = () => {
          if (!opened.tunnel.retirementConfirmed && !opened.tunnel.resetRetirementRequest) {
            opened.assertCurrent()
          }
          local.assertDrained()
          remote.assertDrained()
        }
        return {
          assertDrained,
          drain: async (signal: AbortSignal) => {
            const observer = new AbortController()
            try {
              const combined = AbortSignal.any([signal, observer.signal])
              await Promise.all([local.drain(combined), remote.drain(combined)])
              signal.throwIfAborted()
              assertDrained()
            } finally {
              observer.abort()
            }
          }
        }
      }
    }
  }
}
