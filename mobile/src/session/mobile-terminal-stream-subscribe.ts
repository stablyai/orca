import type { RpcClient } from '../transport/rpc-client'

export function subscribeMobileTerminalSafely(
  client: Pick<RpcClient, 'subscribe'>,
  params: unknown,
  onData: Parameters<RpcClient['subscribe']>[2],
  onSynchronousError: () => void
): () => void {
  try {
    return client.subscribe('terminal.subscribe', params, onData)
  } catch {
    // Why: a transport mock or closing socket can reject before returning an
    // unsubscribe handle; callers must still release their subscribing marker.
    onSynchronousError()
    return () => {}
  }
}
