export type AntigravityAccountOperation = {
  deadline: number
  signal: AbortSignal
  remainingMs?: () => number
}

export function createAntigravityAccountOperation(
  signal: AbortSignal = new AbortController().signal
): AntigravityAccountOperation {
  const expiresAt = performance.now() + 15_000
  return {
    deadline: Date.now() + 15_000,
    signal,
    remainingMs: () => expiresAt - performance.now()
  }
}

export function remainingAccountOperationMs(operation: AntigravityAccountOperation): number {
  if (operation.signal.aborted) {
    throw new Error('Antigravity account operation timed out or cancelled')
  }
  const remaining = operation.remainingMs?.() ?? operation.deadline - Date.now()
  if (remaining <= 0) {
    throw new Error('Antigravity account operation timed out')
  }
  return Math.max(1, Math.ceil(remaining))
}

export async function withAntigravityAccountOperation<T>(
  run: (operation: AntigravityAccountOperation) => Promise<T>,
  parent: AntigravityAccountOperation = createAntigravityAccountOperation()
): Promise<T> {
  const timeoutMs = remainingAccountOperationMs(parent)
  const controller = new AbortController()
  const operation = { ...parent, signal: AbortSignal.any([parent.signal, controller.signal]) }
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('Antigravity account operation cancelled'))
    parent.signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => {
      reject(new Error('Antigravity account operation timed out; refresh to verify the result'))
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        remainingAccountOperationMs(operation)
        const result = await run(operation)
        remainingAccountOperationMs(operation)
        return result
      }),
      interrupted
    ])
  } finally {
    clearTimeout(timer)
    if (cancel) {
      parent.signal.removeEventListener('abort', cancel)
    }
  }
}
