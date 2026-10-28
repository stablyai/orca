import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { splitWorktreeId } from '../../shared/worktree/id'

type Scope = {
  host: string
  path: string
  users: Map<symbol, (() => boolean) | undefined>
  closing: symbol | null
}
const scopes = new Map<string, Scope>()
const globalUsers = new Set<symbol>()

export function beginConditionalWorktreeGlobalUse(owner?: symbol): () => void {
  if ([...scopes.values()].some((scope) => scope.closing !== null && scope.closing !== owner)) {
    throw new ConditionalWorktreeRemovalInProgressError()
  }
  const token = Symbol()
  globalUsers.add(token)
  return () => {
    globalUsers.delete(token)
  }
}

export class ConditionalWorktreeRemovalInProgressError extends Error {
  readonly code = 'conditional_worktree_removal_in_progress'
  constructor() {
    super('Workspace removal is in progress; refresh the workspace before opening it.')
  }
}

function canonicalGatePath(path: string): string {
  const missing: string[] = []
  let candidate = resolve(path)
  for (let depth = 0; depth < 64; depth++) {
    try {
      return normalizeRuntimePathForComparison(resolve(realpathSync.native(candidate), ...missing))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      const parent = dirname(candidate)
      if (parent === candidate) {
        throw error
      }
      missing.unshift(basename(candidate))
      candidate = parent
    }
  }
  throw new Error('conditional_worktree_path_unverifiable')
}

function overlapping(host: string, path: string, canonical = false): Scope[] {
  return [...scopes.values()].filter(
    (scope) =>
      scope.host === host &&
      (() => {
        const candidate = canonical ? canonicalGatePath(scope.path) : scope.path
        return isPathInsideOrEqual(candidate, path) || isPathInsideOrEqual(path, candidate)
      })()
  )
}

function scopeFor(host: string, path: string): [string, Scope] {
  const key = JSON.stringify([host, path])
  let scope = scopes.get(key)
  if (!scope) {
    scope = { host, path, users: new Map(), closing: null }
    scopes.set(key, scope)
  }
  return [key, scope]
}

function forget(key: string, scope: Scope): void {
  if (scope.users.size === 0 && scope.closing === null && scopes.get(key) === scope) {
    scopes.delete(key)
  }
}

export function beginConditionalWorktreePathUse(
  path: string,
  host = 'local',
  owner?: symbol,
  stillPresent?: () => boolean
): () => void {
  const closing = [...scopes.values()].some(
    (scope) => scope.host === host && scope.closing !== null
  )
  try {
    path = closing ? canonicalGatePath(path) : normalizeRuntimePathForComparison(path)
  } catch {
    throw new ConditionalWorktreeRemovalInProgressError()
  }
  if (
    overlapping(host, path, closing).some(
      (scope) => scope.closing !== null && scope.closing !== owner
    )
  ) {
    throw new ConditionalWorktreeRemovalInProgressError()
  }
  const [key, scope] = scopeFor(host, path)
  const token = Symbol()
  scope.users.set(token, stillPresent)
  return () => {
    scope.users.delete(token)
    forget(key, scope)
  }
}

export function beginConditionalWorktreeUse(
  workspaceId: string,
  host = 'local',
  stillPresent?: () => boolean
): () => void {
  const parsed = splitWorktreeId(workspaceId)
  return parsed?.worktreePath
    ? beginConditionalWorktreePathUse(parsed.worktreePath, host, undefined, stillPresent)
    : () => {}
}

/** No waiting or cancellation: a previously admitted user operation always wins. */
export function tryAcquireConditionalWorktreeRemoval(
  path: string,
  host = 'local'
): { kind: 'busy' } | { kind: 'acquired'; token: symbol; release: () => void } {
  if (
    scopes.size > 1024 ||
    [...scopes.values()].reduce((sum, scope) => sum + scope.users.size, 0) > 10000
  ) {
    return { kind: 'busy' }
  }
  for (const [key, scope] of scopes) {
    for (const [token, present] of scope.users) {
      if (!present) {
        continue
      }
      try {
        if (!present()) {
          scope.users.delete(token)
        }
      } catch {
        return { kind: 'busy' }
      }
    }
    forget(key, scope)
  }
  if (
    globalUsers.size > 0 ||
    scopes.size > 1024 ||
    [...scopes.values()].some((scope) => scope.closing !== null)
  ) {
    return { kind: 'busy' }
  }
  try {
    path = canonicalGatePath(path)
    if (
      overlapping(host, path, true).some((scope) => scope.closing !== null || scope.users.size > 0)
    ) {
      return { kind: 'busy' }
    }
  } catch {
    return { kind: 'busy' }
  }
  const [key, scope] = scopeFor(host, path)
  const token = Symbol()
  scope.closing = token
  return {
    kind: 'acquired',
    token,
    release: () => {
      if (scope.closing === token) {
        scope.closing = null
      }
      forget(key, scope)
    }
  }
}
