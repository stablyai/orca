// Git-authority guard for audited worktrees.
//
// SCOPE — read this before relying on it:
// This guard covers Orca's own IPC and RPC Git surfaces only. It is NOT process
// containment. A terminal session, an agent with shell access, an external
// editor, or any process outside Orca can still mutate an audited worktree.
// Drift is DETECTED after the fact by audited-worktree-drift-verifier.ts — it is
// not PREVENTED. True containment is explicitly out of scope for Phase 3.
//
// Placement: called from Orca's mutation boundaries (ipc/filesystem.ts,
// ipc/worktrees.ts, runtime/orca-runtime-git.ts, rpc/methods/worktree.ts), never
// from the general-purpose git primitives — those stay untouched so unrelated
// internal callers can't be surprised by an audited-specific throw.
import {
  isAuditedWorktreePath,
  isAuditedWorktreeRegistryReady
} from './audited-worktree-registry'

// Fixed, sanitized text. Never contains a path, branch, task id, provenance, or
// any attempt evidence.
export const AUDITED_WORKTREE_REFUSAL_MESSAGE =
  'This worktree is managed by the Audited Workflow. Git changes must go through the audited task.'

// Fixed, sanitized text for the fail-closed case. Never contains a database
// error, a path, or a task identity.
export const AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE =
  'Git actions are temporarily unavailable while Orca verifies audited workspaces. Restart Orca and try again.'

export class AuditedWorktreeAuthorityError extends Error {
  readonly code = 'audited_worktree_git_authority_refused'

  constructor() {
    super(AUDITED_WORKTREE_REFUSAL_MESSAGE)
    this.name = 'AuditedWorktreeAuthorityError'
  }
}

// Distinct from the refusal above so callers/tests can tell "this worktree is
// audited" apart from "we cannot currently tell". Both are sanitized.
export class AuditedWorktreeRegistryUnavailableError extends Error {
  readonly code = 'audited_worktree_registry_unavailable'

  constructor() {
    super(AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE)
    this.name = 'AuditedWorktreeRegistryUnavailableError'
  }
}

export const AUDITED_GIT_MUTATION_OPERATIONS = [
  'commit',
  'push',
  'pull',
  'fetch',
  'fastForward',
  'rebase',
  'forkSync',
  'checkout',
  'stage',
  'unstage',
  'discard',
  'abortMerge',
  'abortRebase',
  'appendGitignore',
  'worktreeRemove',
  'worktreeMove',
  'branchDelete'
] as const
export type AuditedGitMutationOperation = (typeof AUDITED_GIT_MUTATION_OPERATIONS)[number]

/**
 * Synchronous, path-keyed, no I/O — a single Set membership test, plus the
 * fail-closed check. Refuses EVERY path (audited or ordinary) while the registry
 * is not ready, because membership is unknowable until both durable sources
 * have loaded.
 */
export function isAuditedWorktreeGitMutationRefused(
  worktreePath: string | null | undefined
): boolean {
  if (!isAuditedWorktreeRegistryReady()) {
    return true
  }
  return typeof worktreePath === 'string' && isAuditedWorktreePath(worktreePath)
}

/**
 * Throws a sanitized error when the target is an audited worktree, or when the
 * registry is not ready. Used by surfaces whose contract is to throw (e.g.
 * git:push, which returns void).
 */
export function assertGitMutationAllowed(worktreePath: string | null | undefined): void {
  if (!isAuditedWorktreeRegistryReady()) {
    throw new AuditedWorktreeRegistryUnavailableError()
  }
  if (typeof worktreePath === 'string' && isAuditedWorktreePath(worktreePath)) {
    throw new AuditedWorktreeAuthorityError()
  }
}

/** For surfaces returning `{ success, error }` rather than throwing. */
export function auditedWorktreeRefusalResult(): { success: false; error: string } {
  return {
    success: false,
    error: isAuditedWorktreeRegistryReady()
      ? AUDITED_WORKTREE_REFUSAL_MESSAGE
      : AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE
  }
}
