export type AntigravityAccountOperation = { deadline: number; signal: AbortSignal }

export function remainingAccountOperationMs(operation: AntigravityAccountOperation): number {
  if (operation.signal.aborted || Date.now() >= operation.deadline) {
    throw new Error('Antigravity account operation timed out')
  }
  return Math.max(1, operation.deadline - Date.now())
}

export async function withAntigravityAccountOperation<T>(
  run: (operation: AntigravityAccountOperation) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const operation = { deadline: Date.now() + 15_000, signal: controller.signal }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Antigravity account operation timed out; refresh to verify the result'))
    }, 15_000)
    timer.unref?.()
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run(operation)), timeout])
  } finally {
    clearTimeout(timer)
  }
}
