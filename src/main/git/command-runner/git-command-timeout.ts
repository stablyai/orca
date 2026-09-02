import { classifyGitCommand } from '../wsl-direct-git-read-commands'

export const GIT_READ_TIMEOUT_MS = 120_000

export class GitCommandTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super('git timed out.')
    this.name = 'GitCommandTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export function gitCommandTimeoutMs(
  args: readonly string[],
  explicitTimeoutMs: number | undefined,
  defaultReadTimeoutMs = GIT_READ_TIMEOUT_MS
): number | undefined {
  return (
    explicitTimeoutMs ?? (classifyGitCommand(args) === 'read' ? defaultReadTimeoutMs : undefined)
  )
}
