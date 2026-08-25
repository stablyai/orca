let transactionTail: Promise<void> = Promise.resolve()

export function runCodexHookTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = transactionTail.then(operation, operation)
  transactionTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export function resetCodexHookTransactionQueueForTests(): void {
  transactionTail = Promise.resolve()
}
