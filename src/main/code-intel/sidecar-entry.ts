import ts from 'typescript'
import { LanguageServicePool } from './language-service-pool'
import { getDefinition, findReferences } from './navigation'
import type { SidecarRequest, SidecarResponse } from './sidecar-protocol'

const pool = new LanguageServicePool({ maxServices: 3, idleMs: 5 * 60_000 })
const cancellers = new Map<number, { cancel: () => void }>()

function makeToken(id: number): ts.CancellationToken {
  let cancelled = false
  cancellers.set(id, { cancel: () => (cancelled = true) })
  return {
    isCancellationRequested: () => cancelled,
    throwIfCancellationRequested: () => {
      if (cancelled) {
        throw new ts.OperationCanceledException()
      }
    }
  }
}

function send(response: SidecarResponse): void {
  process.send?.(response)
}

process.on('message', (message: SidecarRequest) => {
  if (message.kind === 'cancel') {
    cancellers.get(message.id)?.cancel()
    return
  }
  const token = makeToken(message.id)
  try {
    const result =
      message.method === 'definition'
        ? getDefinition(pool, message.params, token)
        : findReferences(pool, message.params, token)
    send({ id: message.id, ok: true, result })
  } catch (error) {
    send({
      id: message.id,
      ok: false,
      error: {
        code: 'sidecar-failure',
        message: error instanceof Error ? error.message : String(error)
      }
    })
  } finally {
    cancellers.delete(message.id)
  }
})
