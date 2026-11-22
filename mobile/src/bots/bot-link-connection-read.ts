import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** A silent second host cannot retain an already-disconnected host's opening drawer. */
export async function readWhileBotLinkConnected<T>(
  client: RpcClient,
  read: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const abort = new AbortController()
  let release = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const disconnected = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      abort.abort()
      reject(new Error('Bot link host is unreachable'))
    }
    release = client.onStateChange((state) => {
      if (state !== 'connected') {
        fail()
      }
    })
    options.signal?.addEventListener('abort', fail, { once: true })
    const disconnect = release
    release = () => {
      disconnect()
      options.signal?.removeEventListener('abort', fail)
    }
    timer = setTimeout(fail, options.timeoutMs ?? 15_000)
    if (options.signal?.aborted || client.getState() !== 'connected') {
      fail()
    }
  })
  try {
    return await Promise.race([
      abort.signal.aborted
        ? Promise.reject(new Error('Bot link read cancelled'))
        : read(abort.signal),
      disconnected
    ])
  } finally {
    clearTimeout(timer)
    release()
    abort.abort()
  }
}
