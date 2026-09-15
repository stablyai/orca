import type { SessionSearchScanRoots } from '../ai-vault-search/session-search-scan-roots'
import type { AiVaultServiceParentMessage } from './session-scanner-service-protocol'

let nextId = 1

/** The parent owns managed-account discovery; the child owns the sweep's lifetime. */
export async function requestSessionSearchRoots(
  signal: AbortSignal
): Promise<SessionSearchScanRoots> {
  signal.throwIfAborted()
  const id = nextId++
  const pending = Promise.withResolvers<SessionSearchScanRoots>()
  const onAbort = (): void => pending.reject(signal.reason)

  const onMessage = (message: AiVaultServiceParentMessage): void => {
    if (message?.type !== 'sessionSearchRoots' || message.id !== id) {
      return
    }

    if (message.roots) {
      pending.resolve(message.roots)
    } else {
      pending.reject(new Error('Session search root discovery failed.'))
    }
  }

  process.on('message', onMessage)
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    if (!process.send) {
      throw new Error('Session search root discovery requires parent IPC.')
    }

    process.send({ type: 'sessionSearchRoots', id }, (error) => {
      if (error) {
        pending.reject(error)
      }
    })

    return await pending.promise
  } finally {
    process.removeListener('message', onMessage)
    signal.removeEventListener('abort', onAbort)
  }
}
