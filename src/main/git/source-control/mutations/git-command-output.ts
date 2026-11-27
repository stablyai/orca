export function joinGitOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join('\n')
}

// Keep Git's diagnostics; spawn failures carry only an Error message.
export function readGitErrorOutput(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const output = joinGitOutput(
      'stdout' in error ? error.stdout : undefined,
      'stderr' in error ? error.stderr : undefined
    )
    if (output) {
      return output
    }
  }
  return error instanceof Error ? error.message : String(error)
}
