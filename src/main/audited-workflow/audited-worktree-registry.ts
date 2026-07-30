// In-memory, path-keyed registry of audited worktree paths. The authority guard
// consults this synchronously on every Orca Git mutation, so it must never do
// I/O or hit SQLite on the hot path.
//
// Membership is a pure function of attempt status
// (REGISTRY_GUARDED_ATTEMPT_STATUSES). A path is published at CLAIM time —
// before `git worktree add` runs — because the window between a successful add
// and finalization is async, and the directory is fully mutable during it.
// A path is released only when recovery proved all Git evidence absent.
import { REGISTRY_GUARDED_ATTEMPT_STATUSES } from '../../shared/audited-worktree-types'
import { canonicalizeAllowingMissing, pathsEqualForHost } from './audited-worktree-managed-root'

// Stored case-folded on win32 so lookups are O(1) rather than a linear scan.
const guardedPaths = new Set<string>()

/**
 * Registry availability. FAIL-CLOSED by design: until a rebuild has loaded BOTH
 * durable sources, the guard cannot know which worktrees are audited, so every
 * Git/worktree mutation boundary must refuse rather than assume "not audited".
 *
 * A rebuild failure (unreadable/corrupt DB) leaves this 'unavailable' — silently
 * continuing with an empty registry would disable protection for every existing
 * audited worktree while the app looked healthy.
 */
type RegistryState = 'uninitialized' | 'ready' | 'unavailable'
let registryState: RegistryState = 'uninitialized'

// Set once by registerAuditedWorkflowHandlers. Until Audited Workflow has been
// wired up in this process, there are no audited worktrees to protect, so the
// guard must not refuse ordinary Git work — that would break every non-audited
// surface in an app (or unit test) that never initializes the feature.
let registryRequired = false

export function requireAuditedWorktreeRegistry(): void {
  registryRequired = true
}

/**
 * Ready means "the guard's answer can be trusted". Once the feature is wired up,
 * that requires a completed rebuild; before then, there is nothing to guard.
 */
export function isAuditedWorktreeRegistryReady(): boolean {
  return registryRequired ? registryState === 'ready' : true
}

export function markAuditedWorktreeRegistryUnavailable(): void {
  registryState = 'unavailable'
  // The guard must fail closed from here regardless of whether a rebuild was
  // previously attempted.
  registryRequired = true
  // Why clear: stale membership from an earlier successful rebuild must not be
  // read as authoritative once the durable sources can no longer be trusted.
  guardedPaths.clear()
}

function toKey(path: string): string {
  const canonical = canonicalizeAllowingMissing(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function publishAuditedWorktreePath(path: string): void {
  guardedPaths.add(toKey(path))
}

/**
 * Releases a guarded path. Call ONLY from a proven-all-evidence-absent branch
 * (attempt -> abandoned or -> failed_no_effect) after its CAS commits.
 */
export function releaseAuditedWorktreePath(path: string): void {
  guardedPaths.delete(toKey(path))
}

export function isAuditedWorktreePath(path: string): boolean {
  if (!path) {
    return false
  }
  return guardedPaths.has(toKey(path))
}

export function getGuardedAuditedWorktreePaths(): string[] {
  return [...guardedPaths]
}

// Tests that exercise guarded behavior need a ready registry; tests that
// exercise fail-closed behavior call markAuditedWorktreeRegistryUnavailable().
export function clearAuditedWorktreeRegistryForTests(): void {
  guardedPaths.clear()
  registryState = 'ready'
  registryRequired = true
}

export function resetAuditedWorktreeRegistryStateForTests(): void {
  guardedPaths.clear()
  registryState = 'uninitialized'
  registryRequired = false
}

// Exported for the rebuild query so the SQL status list and the membership rule
// cannot drift apart.
export const REGISTRY_REBUILD_STATUSES = REGISTRY_GUARDED_ATTEMPT_STATUSES

/**
 * Rebuilds the registry from both durable sources: finalized task worktree
 * identities and non-released attempt intended paths. Must run before any Git
 * mutation handler is registered.
 *
 * Marks the registry ready ONLY after both sources have been loaded — the
 * caller passes the already-collected union, so reaching this point means both
 * queries succeeded.
 */
export function rebuildAuditedWorktreeRegistry(paths: readonly string[]): void {
  guardedPaths.clear()
  for (const path of paths) {
    if (path) {
      publishAuditedWorktreePath(path)
    }
  }
  registryState = 'ready'
}

// Re-exported so guard call sites compare paths the same way the registry keys
// them, without importing the managed-root module directly.
export { pathsEqualForHost }
