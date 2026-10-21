export type SshExecOptions = {
  wrapCommand?: boolean
  /**
   * True lets a long command travel compressed. Only `execCommand` asks: it alone resends plain
   * to a host without base64 or gzip, so direct `exec` callers keep the plain path.
   */
  compressCommand?: boolean
  signal?: AbortSignal
}

export function createSshOperationAbortError(): Error & { name: string } {
  const error = new Error('SSH operation was cancelled')
  error.name = 'AbortError'
  return error
}
