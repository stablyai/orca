import type { WslBrowserNetworkRelayChild } from './wsl-browser-network-relay-launch'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../../shared/browser-network-tunnel-stream-framing'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route'

type WslBrowserNetworkExecutionRouteDependencies = {
  launchRelay?: (distro: string, signal: AbortSignal) => Promise<WslBrowserNetworkRelayChild>
}

export async function resolveWslBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext,
  dependencies: WslBrowserNetworkExecutionRouteDependencies = {}
): Promise<BrowserNetworkExecutionRoute> {
  const host = context.executionHost
  if (
    host.kind !== 'wsl' ||
    host.runtimeId !== context.runtimeId ||
    host.revision !== context.runtimeRevision
  ) {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  if (context.signal?.aborted) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  const routeAbort = new AbortController()
  const abortRoute = (): void => routeAbort.abort()
  context.signal?.addEventListener('abort', abortRoute, { once: true })
  const launchRelay =
    dependencies.launchRelay ??
    (await import('./wsl-browser-network-relay-launch')).launchWslBrowserNetworkRelay
  let child: WslBrowserNetworkRelayChild
  try {
    child = await launchRelay(host.distro, routeAbort.signal)
  } catch (error) {
    context.signal?.removeEventListener('abort', abortRoute)
    throw error
  }

  let valid = true
  let resolveInvalidated = (): void => {}
  const whenInvalidated = new Promise<void>((resolve) => {
    resolveInvalidated = resolve
  })
  let client: BrowserNetworkTunnelClient
  const writer = new BrowserNetworkTunnelStreamFrameWriter(
    (bytes, callback) => child.stdin.write(bytes, callback),
    (error) => invalidate(error)
  )
  const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => client.handleBinary(frame),
    (error) => invalidate(error)
  )
  client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 1,
    sendBinary: (frame) => writer.send(frame),
    onClosed: (error) => invalidate(error)
  })

  const invalidate = (error: Error, kill = true): void => {
    if (!valid) {
      return
    }
    valid = false
    context.signal?.removeEventListener('abort', abortRoute)
    routeAbort.abort()
    decoder.close()
    writer.close()
    client.close(error)
    if (kill && !child.killed) {
      child.kill()
    }
    resolveInvalidated()
  }
  const onAbort = (): void => invalidate(new Error('browser_tunnel_execution_host_unavailable'))
  routeAbort.signal.addEventListener('abort', onAbort, { once: true })
  child.stdout.on('data', (bytes: Buffer) => decoder.feed(bytes))
  child.stdout.on('error', (error) => invalidate(error))
  child.stdin.on('error', (error) => invalidate(error))
  child.on('error', (error) => invalidate(error, false))
  child.on('close', () => invalidate(new Error('browser_tunnel_execution_host_unavailable'), false))

  if (routeAbort.signal.aborted) {
    invalidate(new Error('browser_tunnel_execution_host_unavailable'))
  }

  return {
    key: browserNetworkExecutionHostKey(host),
    connect: (target) => {
      const socket = new BrowserNetworkDeferredSocket()
      if (!valid) {
        queueMicrotask(() => socket.fail(new Error('browser_tunnel_execution_host_unavailable')))
        return socket
      }
      void client.open(target).then(
        (source) => socket.attach(source),
        (error) => socket.fail(error instanceof Error ? error : new Error(String(error)))
      )
      return socket
    },
    whenInvalidated,
    isValid: () => valid,
    close: () => invalidate(new Error('browser_tunnel_execution_host_unavailable'))
  }
}
