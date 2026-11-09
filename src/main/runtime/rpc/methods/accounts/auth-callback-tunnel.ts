import { connect as netConnect, type Socket } from 'node:net'
import { BrowserNetworkTunnelSession } from '../../../../browser/network/tunnels/browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../../../browser/network/tunnels/browser-network-tunnel-stream-state'
import type { BrowserNetworkTunnelSocket } from '../../../../browser/network/tunnels/browser-network-tunnel-stream-state'
import {
  AUTH_CALLBACK_FORWARD_MAX_BYTES as AUTH_CALLBACK_TUNNEL_MAX_BYTES,
  AUTH_CALLBACK_FORWARD_MAX_STREAMS as AUTH_CALLBACK_TUNNEL_MAX_STREAMS,
  AUTH_CALLBACK_FORWARD_TTL_MS as AUTH_CALLBACK_TUNNEL_TTL_MS
} from '../../../../../shared/auth-callback-forward'
import { AuthCallbackTunnelParams } from '../../../../../shared/rpc-contract/accounts-params'
import { HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY } from '../../../../../shared/account-runtime-capabilities'
import { defineStreamingMethod, type RpcContext } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { HostAccountSignInFlows } from '../../../agent-session/environment/host-account-sign-in-flows'

// Tunnel generations only need to be positive; each subscription is its own session.
const TUNNEL_GENERATION = 1

/** Dials only the flow's own callback port on loopback, counting streams and bytes against the caps. */
export function createAuthCallbackDialer(
  port: number,
  onExceeded: () => void,
  dial: (port: number) => Socket = (target) =>
    netConnect({ host: 'localhost', port: target, autoSelectFamily: true, allowHalfOpen: true }),
  onStreamClosed?: () => void
): (target: { host: string; port: number }) => BrowserNetworkTunnelSocket {
  let streams = 0
  let bytes = 0
  const count = (socket: Socket, byteLength: number): void => {
    bytes += byteLength
    if (bytes > AUTH_CALLBACK_TUNNEL_MAX_BYTES) {
      socket.destroy()
      onExceeded()
    }
  }
  return (target) => {
    if (target.port !== port || (target.host !== '127.0.0.1' && target.host !== 'localhost')) {
      throw new Error('auth_callback_destination_refused')
    }
    if (streams >= AUTH_CALLBACK_TUNNEL_MAX_STREAMS) {
      onExceeded()
      throw new Error('auth_callback_stream_limit')
    }
    streams += 1
    const socket = dial(port)
    if (onStreamClosed) {
      socket.once('close', onStreamClosed)
    }
    const wrapper: BrowserNetworkTunnelSocket = {
      get destroyed() {
        return socket.destroyed
      },
      setNoDelay: (noDelay) => {
        socket.setNoDelay(noDelay)
        return wrapper
      },
      pause: () => {
        socket.pause()
        return wrapper
      },
      resume: () => {
        socket.resume()
        return wrapper
      },
      write: (chunk, callback) => {
        count(socket, chunk.byteLength)
        return socket.write(chunk, callback)
      },
      end: () => {
        socket.end()
        return wrapper
      },
      destroy: () => {
        socket.destroy()
        return wrapper
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one implementation serves every overload of `on`.
      on: ((event: string, listener: (...args: never[]) => void) => {
        if (event === 'data') {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the 'data' overload's listener takes the chunk.
          const onData = listener as (chunk: Uint8Array) => void
          socket.on('data', (chunk: Uint8Array) => {
            count(socket, chunk.byteLength)
            onData(chunk)
          })
        } else {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarded unchanged to the socket's own event of that name.
          socket.on(event, listener as (...args: unknown[]) => void)
        }
        return wrapper
      }) as BrowserNetworkTunnelSocket['on']
    }
    return wrapper
  }
}

type CallbackGrant = { port: number; ended: AbortSignal }
type TunnelEmit = (event: unknown) => void

/** Serves one binary tunnel to `grant.port` on loopback until the grant ends, the caller leaves or the TTL. */
export async function serveCallbackTunnel(
  ctx: RpcContext,
  emit: TunnelEmit,
  grant: CallbackGrant,
  subscriptionKey: string,
  onStreamClosed?: () => void
): Promise<void> {
  const { runtime, connectionId, sendBinary, registerBinaryMessageHandler, signal } = ctx
  if (!connectionId || !sendBinary || !registerBinaryMessageHandler || signal?.aborted) {
    return
  }
  const closed = Promise.withResolvers<void>()
  let session: BrowserNetworkTunnelSession | null = null
  let unregisterBinary = (): void => {}
  const close = (): void => session?.close()
  const ttl = setTimeout(close, AUTH_CALLBACK_TUNNEL_TTL_MS)
  const subscriptionId = JSON.stringify(['auth-callback-tunnel', connectionId, subscriptionKey])
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) {
      return
    }
    cleaned = true
    clearTimeout(ttl)
    grant.ended.removeEventListener('abort', close)
    signal?.removeEventListener('abort', close)
    unregisterBinary()
    close()
    closed.resolve()
  }
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: TUNNEL_GENERATION,
    connect: createAuthCallbackDialer(grant.port, close, undefined, onStreamClosed),
    sendBinary: (bytes) => sendBinary(bytes) !== false,
    flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
    onClose: () => {
      try {
        emit({ type: 'closed', tunnelGeneration: TUNNEL_GENERATION })
      } finally {
        cleanup()
      }
    }
  })
  console.info(`[auth-callback-tunnel] opened for port ${grant.port}`)
  unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
  runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
  grant.ended.addEventListener('abort', close, { once: true })
  signal?.addEventListener('abort', close, { once: true })
  if (grant.ended.aborted || signal?.aborted) {
    close()
  } else {
    emit({ type: 'ready', tunnelGeneration: TUNNEL_GENERATION })
  }
  try {
    await closed.promise
  } finally {
    cleanup()
    console.info(`[auth-callback-tunnel] closed for port ${grant.port}`)
  }
}

/** The tunnel needs a desktop runtime client that can carry binary frames. */
export function requireCallbackTunnelClient(ctx: RpcContext): void {
  const { connectionId, clientKind, clientCapabilities, sendBinary, registerBinaryMessageHandler } =
    ctx
  if (clientKind !== 'runtime' || !connectionId || !sendBinary || !registerBinaryMessageHandler) {
    throw new Error('authenticated_binary_auth_callback_tunnel_required')
  }
  if (!clientCapabilities?.includes(HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY)) {
    throw new Error('auth_callback_tunnel_capability_required')
  }
}

/** Carries a desktop browser's redirect to the localhost callback of a sign-in this caller started here. */
export function createAuthCallbackTunnelMethod(
  flowsFor: (runtime: OrcaRuntimeService) => HostAccountSignInFlows,
  ownerOf: (ctx: Pick<RpcContext, 'caller'>) => string
) {
  return defineStreamingMethod({
    name: 'network.authCallbackTunnel',
    permission: 'accounts-admin',
    params: AuthCallbackTunnelParams,
    handler: async (params, ctx, emit) => {
      requireCallbackTunnelClient(ctx)
      const grant = flowsFor(ctx.runtime).callbackTarget(ownerOf(ctx), params.flowId)
      if (!grant) {
        throw new Error('auth_callback_not_waiting')
      }
      // The grant ends with the login: success, failure, cancel or the owner going silent.
      await serveCallbackTunnel(ctx, emit, grant, params.flowId)
    }
  })
}
