export async function recoverClientPagesWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < values.length && !signal?.aborted) {
      const value = values[index]
      index += 1
      if (value !== undefined) {
        await operation(value)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
}
