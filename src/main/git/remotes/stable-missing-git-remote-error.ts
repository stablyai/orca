export function isStableMissingGitRemoteError(error: unknown): boolean {
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.message)
  }
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string') {
      parts.push(stderr)
    }
  }
  if (parts.length === 0) {
    parts.push(String(error))
  }
  return /no such remote/i.test(parts.join('\n'))
}
