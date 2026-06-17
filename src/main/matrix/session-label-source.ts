import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { registerSessionHandle } from './session-handle-registry'

// Derives the human label a Matrix session handle is named after, and registers
// the speaking handle for a pane key. The label mirrors the desktop
// notification's source (worktree display name, then repo display name) so the
// room prefix reads like the workspace the operator already recognises —
// `[orca matrix-adapter]` instead of `[orca 3ywa]`.

// Minimal slice of the persistence Store this module needs — keeps it decoupled
// from the full Store type and trivially testable. Store satisfies it.
export type SessionLabelStore = {
  getWorktreeMeta(worktreeId: string): { displayName?: string } | undefined
  getRepo(repoId: string): { displayName?: string } | undefined
}

// Resolves the best human label for a session from its worktree, or undefined
// when none is known (no worktree, or only blank display names) so the caller
// falls back to the deterministic slug.
export function resolveSessionLabel(
  store: SessionLabelStore,
  worktreeId: string | undefined
): string | undefined {
  if (!worktreeId) {
    return undefined
  }
  const worktreeName = store.getWorktreeMeta(worktreeId)?.displayName?.trim()
  if (worktreeName) {
    return worktreeName
  }
  const repoName = store.getRepo(getRepoIdFromWorktreeId(worktreeId))?.displayName?.trim()
  return repoName || undefined
}

// Pane keys whose handle was already ensured this process-run. The handle is
// stable once minted, so re-registering on every subsequent status event would
// only re-read the registry file and return the same value — skip that sync I/O
// on the main-process hot path. Cleared across restarts (the registry file is
// the durable source of truth).
const ensuredPaneKeys = new Set<string>()

// Registers (mints-and-persists on first use) the speaking handle for a pane
// key, sourcing the label from the worktree. Idempotent and stable: once a pane
// key has a handle it is returned unchanged. Call early (on every status event)
// so the name is in place before any outbound prefix or inbound @handle lookup.
// Returns the handle on first registration, or undefined when skipped because
// this pane key was already ensured this run (the caller ignores the value).
export function registerSpeakingHandle(
  store: SessionLabelStore,
  paneKey: string,
  worktreeId: string | undefined
): string | undefined {
  if (ensuredPaneKeys.has(paneKey)) {
    return undefined
  }
  const label = resolveSessionLabel(store, worktreeId)
  if (!label) {
    // No worktree/repo name resolved yet — the metadata may not be in the store
    // on the very first status event, or the session may have no worktree at all.
    // Do NOT mint a fallback slug here: handles are stable once persisted, so a
    // slug minted now would permanently shadow the speaking name. Leave the pane
    // key unregistered so a later event (once the label is known) still mints the
    // speaking handle; on-demand callers (handleForPaneKey) mint a slug only if
    // they genuinely need one before any label is available.
    return undefined
  }
  const handle = registerSessionHandle(paneKey, label)
  ensuredPaneKeys.add(paneKey)
  return handle
}

// Testing seam: clears the process-run cache so each test starts cold.
export function resetSpeakingHandleCacheForTests(): void {
  ensuredPaneKeys.clear()
}
