import { createServer, type AddressInfo, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { pipeBrowserNetworkDestinationToSocket } from '../browser/browser-network-downstream-pipe'
import type { PortForwardStartOptions } from './ssh-port-forward-provider'

export async function startSocketPortForwardListener(options: {
  forward: PortForwardStartOptions
  open: (socket: Socket) => Promise<Duplex>
  disposeDestination: (destination: Duplex) => void
  assertAdmission?: () => void
}) {
  const { forward } = options
  const sockets = new Set<Socket>()
  const work = new TransportPublicationDrain(() => {})
  let fenced = false
  let stopping: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let listenerStopped = false
  const disposeDestination = (destination: Duplex) => {
    try {
      options.disposeDestination(destination)
    } catch (error) {
      work.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    try {
      if (fenced) {
        throw new Error('ssh_port_forward_admission_closed')
      }
      work.assertCurrent()
      options.assertAdmission?.()
    } catch {
      socket.destroy()
      return
    }
    const settleSocket = work.trackWrite()
    sockets.add(socket)
    socket.on('error', (error) => {
      work.fail(error)
      socket.destroy()
    })
    socket.once('close', () => {
      sockets.delete(socket)
      settleSocket(
        socket.readableEnded && socket.writableFinished
          ? { ok: true }
          : { ok: false, error: new Error('ssh_port_forward_socket_close_unverifiable') }
      )
    })
    const settleOpen = work.trackWrite()
    void (async () => {
      try {
        const destination = await options.open(socket)
        if (socket.destroyed) {
          disposeDestination(destination)
        } else {
          socket.pipe(destination)
          pipeBrowserNetworkDestinationToSocket(destination, socket)
          destination.on('close', () => socket.end())
          destination.on('error', (error) => {
            work.fail(error)
            socket.destroy()
          })
          socket.once('close', () => disposeDestination(destination))
        }
        settleOpen({ ok: true })
      } catch (error) {
        settleOpen({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
        socket.destroy()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening)
      reject(
        new Error(`Failed to listen on ${forward.localHost}:${forward.localPort}: ${error.message}`)
      )
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(forward.localPort, forward.localHost)
  })
  const address = server.address() as AddressInfo | null
  if (!address) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('SSH port forward listener did not expose its allocated port')
  }
  const stopListening = () => {
    fenced = true
    stopping ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          work.fail(error)
          reject(error)
        } else {
          listenerStopped = true
          resolve()
        }
      })
    })
    return stopping
  }
  const close = () => {
    closing ??= stopListening()
    for (const socket of sockets) {
      socket.destroy()
    }
    return closing
  }
  return {
    entry: {
      id: forward.id,
      connectionId: forward.connectionId,
      localPort: address.port,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      label: forward.label
    },
    close,
    dispose: () => {
      void close().catch(() => {})
    },
    fenceForDrain: () => {
      const stopped = stopListening()
      void stopped.catch(() => {})
      return {
        drain: async (signal: AbortSignal) => {
          await work.drain(signal)
          signal.throwIfAborted()
          await waitForPromiseWithSignal(stopped, signal)
          signal.throwIfAborted()
          work.assertDrained()
        },
        assertDrained: () => {
          work.assertDrained()
          if (!listenerStopped || server.listening || sockets.size > 0) {
            throw new Error('ssh_port_forward_listener_not_drained')
          }
        }
      }
    }
  }
}
