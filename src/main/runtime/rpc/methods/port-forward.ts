import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../../../browser/browser-network-tunnel-stream-state'
import {
  isForwardablePort,
  resolveLoopbackForwardHost
} from '../../../../shared/loopback-forward-destination'
import { PortForwardAttachParams } from '../../../../shared/port-forward-protocol'
import { PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { defineStreamingMethod } from '../core'

// Why the stream framing is reused verbatim: the browser tunnel's wire format is
// already a general-purpose TCP multiplexer (Open{host,port} plus flow control), so a
// forward is one stream per inbound connection and needs no new opcode. What is NOT
// reused is its authorization — that one is scoped by a browser-host lease and accepts
// any destination, which would be far too broad here.
const MAX_GENERATION = 0xffff_ffff
let lastTunnelGeneration = 0

function mintTunnelGeneration(): number {
  lastTunnelGeneration = lastTunnelGeneration >= MAX_GENERATION ? 1 : lastTunnelGeneration + 1
  return lastTunnelGeneration
}

/** Throwing is the admission contract: the session reports a rejected open as
 *  `destination_connect_failed` without echoing the target back to the client. */
export function connectLoopbackForwardDestination(
  target: BrowserNetworkTunnelOpen
): BrowserNetworkTunnelSocket {
  // Why the resolved literal rather than target.host: dialling the caller's string would
  // send forms the check normalised away back through getaddrinfo, which resolves some of
  // them as names and can land off-host.
  const host = resolveLoopbackForwardHost(target.host)
  if (!host || !isForwardablePort(target.port)) {
    throw new Error('port_forward_destination_refused')
  }
  return connect({ host, port: target.port, allowHalfOpen: true })
}

export function createPortForwardMethods(
  connectDestination: (
    target: BrowserNetworkTunnelOpen
  ) => BrowserNetworkTunnelSocket = connectLoopbackForwardDestination
) {
  return [
    defineStreamingMethod({
      name: 'network.portForward',
      params: PortForwardAttachParams,
      handler: async (
        _params,
        {
          connectionId,
          pairedDeviceId,
          clientKind,
          clientCapabilities,
          sendBinary,
          registerBinaryMessageHandler,
          signal
        },
        emit
      ) => {
        if (
          clientKind !== 'runtime' ||
          !connectionId ||
          !pairedDeviceId ||
          !sendBinary ||
          !registerBinaryMessageHandler
        ) {
          throw new Error('authenticated_binary_port_forward_required')
        }
        if (!clientCapabilities?.includes(PORT_FORWARD_RUNTIME_CAPABILITY)) {
          throw new Error('port_forward_capability_required')
        }
        if (signal?.aborted) {
          return
        }

        const tunnelGeneration = mintTunnelGeneration()
        let resolveClosed = (): void => {}
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve
        })
        let session: BrowserNetworkTunnelSession | null = null
        let unregisterBinary: (() => void) | undefined
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) {
            return
          }
          cleaned = true
          try {
            // Why guarded: cleanup runs from an abort listener, where a throw is
            // unhandled — and it must never skip closing the session below.
            unregisterBinary?.()
          } finally {
            const active = session
            session = null
            active?.close()
          }
        }

        try {
          session = new BrowserNetworkTunnelSession({
            tunnelGeneration,
            connect: connectDestination,
            sendBinary: (bytes) => sendBinary(bytes) !== false,
            onClose: () => {
              try {
                emit({ type: 'closed', tunnelGeneration })
              } finally {
                resolveClosed()
              }
            }
          })
          unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
          signal?.addEventListener('abort', cleanup, { once: true })
          if (signal?.aborted) {
            cleanup()
            return
          }
          emit({ type: 'ready', tunnelGeneration })
          await closed
        } finally {
          signal?.removeEventListener('abort', cleanup)
          cleanup()
        }
      }
    })
  ]
}

export const PORT_FORWARD_METHODS = createPortForwardMethods()
