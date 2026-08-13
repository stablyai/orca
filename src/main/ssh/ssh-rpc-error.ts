export function isSshRpcMethodNotFoundError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === -32601
  )
}
