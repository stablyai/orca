import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { Repo } from '../../../shared/repository/repo-types'

type DurablePolicyStore = {
  runDurableMutation?: <T>(mutate: () => { value: T; persist?: boolean | 'if-dirty' }) => Promise<T>
}

/**
 * Counts every write of cleanup rules, global or project, rollbacks included. Equal values written
 * twice still count twice, so "unchanged" means no write happened, not that a value came back.
 */
let revision = 0
export function noteWorkspaceCleanupPolicyWrite(): void {
  revision += 1
}

const saving = new Set<Promise<void>>()

/**
 * Settings and project rows save on a deferred schedule. A guarded cleanup policy is acknowledged
 * only once that save is on disk: a restart before it would otherwise bring back rules the user was
 * told had changed. A save that fails puts the previous policy back unless a later write replaced it.
 */
export async function persistWorkspaceCleanupPolicy(
  store: DurablePolicyStore,
  rollback?: () => void
): Promise<void> {
  if (!store.runDurableMutation) {
    throw new Error('workspace_cleanup_policy_unavailable')
  }
  const written = revision
  const save = (async () => {
    try {
      await store.runDurableMutation!(() => ({ value: undefined, persist: 'if-dirty' }))
    } catch (error) {
      if (rollback && revision === written) {
        rollback()
      }
      throw error
    }
  })()
  saving.add(save)
  try {
    await save
  } finally {
    saving.delete(save)
  }
}

/** The rules a cleanup decision reads, and the proof they are still the rules when it admits a removal. */
export type WorkspaceCleanupPolicyAuthority = { stillCurrent: () => boolean }

/**
 * Waits until no guarded rules are still being saved, then marks the rules the decision is about to
 * read. Admission accepts the decision only if no rules were written since and none are being saved:
 * a write after this point, saved or rolled back, sends the decision back to be made again.
 */
export async function captureWorkspaceCleanupPolicyAuthority(): Promise<WorkspaceCleanupPolicyAuthority> {
  while (saving.size) {
    await Promise.allSettled(saving)
  }
  const read = revision
  return { stillCurrent: () => revision === read && saving.size === 0 }
}

type PolicySettingsStore = DurablePolicyStore & {
  getSettings?: () => { workspaceCleanupPolicy?: WorkspaceCleanupRules }
  updateSettings?: (
    updates: { workspaceCleanupPolicy?: WorkspaceCleanupRules },
    options?: { notifyListeners?: boolean }
  ) => unknown
}
/** The global rules a guarded write installed, saved, or put back as `before` had them if the save fails. */
export async function persistGuardedSettingsPolicy(
  store: PolicySettingsStore,
  updates: { workspaceCleanupGuard?: unknown },
  beforeSettings: { workspaceCleanupPolicy?: WorkspaceCleanupRules }
): Promise<void> {
  if (!updates.workspaceCleanupGuard) {
    return
  }
  const before = beforeSettings.workspaceCleanupPolicy
  return persistWorkspaceCleanupPolicy(store, () =>
    store.updateSettings?.({ workspaceCleanupPolicy: before }, { notifyListeners: true })
  )
}

type PolicyRepoStore = DurablePolicyStore & {
  updateRepo: (
    target: Repo,
    updates: { workspaceCleanupPolicy: Repo['workspaceCleanupPolicy'] | null }
  ) => unknown
}
/** A project's rules a guarded write installed, saved, or put back to `before` if the save fails. */
export function persistGuardedProjectPolicy(
  store: PolicyRepoStore,
  updated: Repo,
  before: Repo['workspaceCleanupPolicy']
): Promise<void> {
  return persistWorkspaceCleanupPolicy(store, () =>
    store.updateRepo(updated, { workspaceCleanupPolicy: before ?? null })
  )
}

/**
 * A readback is the proof a lost write reply leans on, so it answers only with rules no write has
 * touched between the read and the end of its save: then the save holds exactly what it read.
 */
export async function readDurableWorkspaceCleanupPolicy<T extends { state: unknown }>(
  store: DurablePolicyStore,
  read: () => T
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const written = revision
    const before = JSON.stringify(read().state)
    await persistWorkspaceCleanupPolicy(store)
    const after = read()
    // The value check also covers project rows added or removed, which aren't rule writes.
    if (revision === written && JSON.stringify(after.state) === before) {
      return after
    }
  }
  throw new Error('workspace_cleanup_busy')
}
