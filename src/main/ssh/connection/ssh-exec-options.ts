export type SshExecOptions = {
  wrapCommand?: boolean
  /** Compression is execCommand-only: it can retry plain when hosts lack base64/gzip; direct exec cannot. */
  compressCommand?: boolean
  signal?: AbortSignal
}

export function createSshOperationAbortError(): Error & { name: string } {
  const error = new Error('SSH operation was cancelled')
  error.name = 'AbortError'
  return error
}
