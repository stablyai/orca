import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { hasActiveTraceSink } from './tracer'

export type GitOperationCause = {
  family: 'catalog' | 'refs' | 'status' | 'fetch' | 'setup'
  reason:
    | 'desktop-catalog'
    | 'runtime-catalog'
    | 'worktree-scan'
    | 'creation-base-refresh'
    | 'branch-search'
    | 'status-read'
    | 'remote-fetch'
    | 'base-refresh'
    | 'conflict-preview'
    | 'setup-runner'
  cache: 'miss' | 'expired' | 'refresh' | 'bypass-signal' | 'uncached'
}

type CauseScope = GitOperationCause & { commonDirHash?: string; active: boolean }
const causes = new AsyncLocalStorage<CauseScope>()

export function runWithGitCause<T>(
  cause: GitOperationCause,
  identity: { namespace: string; commonDir: string } | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!hasActiveTraceSink()) {
    return run()
  }
  const parent = causes.getStore()
  const scope: CauseScope = {
    ...cause,
    reason: parent?.active ? parent.reason : cause.reason,
    ...(identity
      ? {
          commonDirHash: createHash('sha256')
            .update(identity.namespace)
            .update('\0')
            .update(identity.commonDir)
            .digest('hex')
            .slice(0, 16)
        }
      : {}),
    active: true
  }
  return causes.run(scope, async () => {
    try {
      return await run()
    } finally {
      // Detached work must not inherit a completed action's cause.
      scope.active = false
    }
  })
}

export function getGitOperationCause(): Readonly<CauseScope> | undefined {
  const scope = causes.getStore()
  return scope?.active ? scope : undefined
}
