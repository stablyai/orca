export function isGitBufferOverflowError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (('code' in error &&
      (error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) ||
      ('message' in error &&
        typeof error.message === 'string' &&
        /^(?:(?:stdout|stderr) maxBuffer length exceeded|git (?:stdout|stderr|output) exceeded maxBuffer\.)$/.test(
          error.message
        )))
  )
}

export function isGitReadInterruptedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (('name' in error && error.name === 'AbortError') ||
      ('timedOut' in error && error.timedOut === true) ||
      ('killed' in error && error.killed === true && !isGitBufferOverflowError(error)))
  )
}
