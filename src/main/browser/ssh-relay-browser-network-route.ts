import type { openRegisteredSshNetworkTunnel } from '../ssh/ssh-target-registry'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route'
import { SshConnectionWorkLedger } from '../ssh/ssh-connection-work-ledger'
import { trackSshConnectionChannelLifetime } from '../ssh/ssh-connection-channel-lifetime'

type OpenedTunnel = Awaited<ReturnType<typeof openRegisteredSshNetworkTunnel>>

export function createSshRelayBrowserNetworkRoute(options: {
  key: string
  opened: OpenedTunnel
  signal: AbortSignal
  assertCurrent: () => void
  releaseInvalidation: () => void
}): BrowserNetworkExecutionRoute {
  const { opened, signal } = options
  const lifetime = new SshConnectionWorkLedger()
  let closed = false
  let closing: Promise<void> | undefined
  const invalidated = Promise.withResolvers<void>()
  const assertCurrent = () => {
    if (signal.aborted) {
      throw new Error('browser_tunnel_execution_host_stale')
    }
    options.assertCurrent()
    opened.assertCurrent()
  }
  const onAbort = () => {
    opened.tunnel.fail(new Error('browser_tunnel_execution_host_stale'))
    invalidated.resolve()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    onAbort()
  }
  return {
    key: options.key,
    whenInvalidated: invalidated.promise,
    isValid: () => {
      if (closed) {
        return false
      }
      try {
        assertCurrent()
        return true
      } catch {
        return false
      }
    },
    connect: (target) => {
      const socket = new BrowserNetworkDeferredSocket()
      const open = async () => {
        if (closed) {
          throw new Error('browser_tunnel_execution_host_stale')
        }
        assertCurrent()
        opened.assertAdmission()
        const opening = lifetime.beginChannelOpen()
        let source: Awaited<ReturnType<typeof opened.tunnel.open>>
        try {
          source = await opened.tunnel.open(target)
        } catch (error) {
          // No source reached this wrapper; the tunnel cohort still owns failed internal streams.
          opening.close()
          throw error
        }
        trackSshConnectionChannelLifetime(opening, source)
        try {
          assertCurrent()
          socket.attach(source)
        } catch (error) {
          try {
            source.destroy()
          } catch (failure) {
            opening.markUnverifiable(
              failure instanceof Error ? failure : new Error(String(failure))
            )
            throw failure
          }
          throw error
        }
      }
      void open().catch((error: unknown) => {
        socket.fail(error instanceof Error ? error : new Error(String(error)))
      })
      return socket
    },
    close: () => {
      if (!closing) {
        const completion = Promise.withResolvers<void>()
        closing = completion.promise
        closed = true
        signal.removeEventListener('abort', onAbort)
        const local = lifetime.fenceForReset()
        // Route release observes the session drain; it never cancels admitted sockets.
        const finish = async () => {
          await Promise.all([
            opened.release(new AbortController().signal),
            local.drain(new AbortController().signal)
          ])
          options.releaseInvalidation()
        }
        void finish().then(completion.resolve, completion.reject)
      }
      return closing
    }
  }
}
