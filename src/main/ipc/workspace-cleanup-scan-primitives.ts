import { basename } from 'node:path'
import type { Repo } from '../../shared/types'
import type { WorkspaceCleanupScanError } from '../../shared/workspace-cleanup'

export const WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS = 8_000

export function appendWorkspaceCleanupItems<T>(target: T[], entries: readonly T[]): void {
  // Why: cleanup can aggregate generated-size worktree batches; spreading
  // those batches into push can exceed JavaScript's argument limit.
  for (const entry of entries) {
    target.push(entry)
  }
}

export async function mapWorkspaceCleanupWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

export async function withWorkspaceCleanupTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  const controller = new AbortController()
  let timeoutId: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(new Error(message))
    }, timeoutMs)
  })
  try {
    return await Promise.race([run(controller.signal), timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export function toWorkspaceCleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWorkspaceCleanupScanError(
  repo: Repo,
  message: string
): WorkspaceCleanupScanError {
  return {
    repoId: repo.id,
    repoName: repo.displayName || basename(repo.path),
    message
  }
}

// Why: git errors often include absolute paths or command output. Keep the
// cause useful without leaking raw local/remote filesystem details to the UI.
export function toSafeWorkspaceCleanupRepoScanError(error: unknown): string {
  const message = toWorkspaceCleanupErrorMessage(error)
  if (message === 'Timed out listing SSH worktrees.') {
    return 'Timed out listing remote worktrees.'
  }
  if (message === 'Timed out listing worktrees.') {
    return 'Timed out listing worktrees.'
  }
  if (message.startsWith('Timed out ')) {
    return message.replace(/\.$/, '')
  }

  const lower = message.toLowerCase()
  if (lower.includes('not a git repository') || lower.includes('not a git worktree')) {
    return 'Repository is not a git checkout.'
  }
  if (
    lower.includes('enoent') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('does not exist')
  ) {
    return 'Repository folder was not found.'
  }
  if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) {
    return 'Repository folder is not accessible.'
  }
  return 'Git could not list worktrees.'
}
