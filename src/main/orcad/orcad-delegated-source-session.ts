import type { PtyOwnershipTransferDelegatedSource } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-source'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { connectOrcadLocalRelay } from './orcad-local-relay-connection'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'

/** A short authenticated source transaction, without a destination claim or output subscription. */
export async function withOrcadDelegatedSource<T>(
  options: {
    source: PtyOwnershipTransferDelegatedSource
    signal: AbortSignal
    timeoutMs?: number
  },
  operation: (client: OrcadDelegatedTransferClient, assertActive: () => void) => Promise<T>
): Promise<T> {
  let multiplexer: SshChannelMultiplexer | undefined
  let closed = false
  let removeDispose = () => {}
  const assertActive = () => {
    options.signal.throwIfAborted()
    if (closed) {
      throw new Error('orcad_delegated_source_session_closed')
    }
  }
  assertActive()
  const abort = () => multiplexer?.dispose()
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    multiplexer = await connectOrcadLocalRelay({
      ...options.source,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      initialize: (connection) => {
        multiplexer = connection
        removeDispose = connection.onDispose(() => {
          closed = true
        })
      }
    })
    assertActive()
    const client = new OrcadDelegatedTransferClient((method, params, requestOptions) => {
      assertActive()
      return multiplexer!.request(method, { ...params }, requestOptions)
    })
    const result = await operation(client, assertActive)
    assertActive()
    return result
  } finally {
    options.signal.removeEventListener('abort', abort)
    removeDispose()
    multiplexer?.dispose()
  }
}
