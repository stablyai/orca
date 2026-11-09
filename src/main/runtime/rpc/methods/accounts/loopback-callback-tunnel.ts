import { LoopbackCallbackTunnelParams } from '../../../../../shared/rpc-contract/accounts-params'
import { defineStreamingMethod } from '../../core'
import { requireCallbackTunnelClient, serveCallbackTunnel } from './auth-callback-tunnel'
import { loopbackListenerPids } from './loopback-callback-listener'

// An OAuth redirect is one request plus maybe a favicon; close soon after the first one finishes.
const ONE_SHOT_GRACE_MS = 3_000
const LISTENER_POLL_MS = 1_000

export type LoopbackCallbackGrantDeps = {
  listenerPids?: (port: number) => Promise<number[]>
  pollMs?: number
}

/** A grant to `port` that lasts only while a host process (not orcad) still listens there. */
export async function grantLoopbackCallbackPort(
  port: number,
  deps: LoopbackCallbackGrantDeps = {}
): Promise<{ port: number; ended: AbortSignal; streamClosed: () => void; release: () => void }> {
  const listenerPids = deps.listenerPids ?? loopbackListenerPids
  if ((await listenerPids(port)).length === 0) {
    throw new Error('loopback_callback_not_listening')
  }
  const ended = new AbortController()
  let checking = false
  const poll = setInterval(() => {
    if (checking) {
      return
    }
    checking = true
    void listenerPids(port)
      .then((pids) => {
        if (pids.length === 0) {
          ended.abort()
        }
      })
      .finally(() => {
        checking = false
      })
  }, deps.pollMs ?? LISTENER_POLL_MS)
  poll.unref?.()
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  ended.signal.addEventListener(
    'abort',
    () => {
      clearInterval(poll)
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
    },
    { once: true }
  )
  return {
    port,
    ended: ended.signal,
    streamClosed: () => {
      graceTimer ??= setTimeout(() => ended.abort(), ONE_SHOT_GRACE_MS)
    },
    release: () => ended.abort()
  }
}

/** Carries a desktop browser's OAuth redirect to a callback an agent on this host is listening for
 * (an MCP server sign-in, say). Same channel, caps and TTL as account sign-in; the port must have a
 * live non-orcad listener owned by this host user, and the tunnel closes once the callback is served. */
export const loopbackCallbackTunnelMethod = defineStreamingMethod({
  name: 'network.loopbackCallbackTunnel',
  permission: 'accounts-admin',
  params: LoopbackCallbackTunnelParams,
  handler: async (params, ctx, emit) => {
    requireCallbackTunnelClient(ctx)
    const grant = await grantLoopbackCallbackPort(params.port)
    try {
      await serveCallbackTunnel(ctx, emit, grant, `port:${params.port}`, grant.streamClosed)
    } finally {
      grant.release()
    }
  }
})
