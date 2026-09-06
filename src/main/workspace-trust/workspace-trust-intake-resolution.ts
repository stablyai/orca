import { resolveWorkspaceTrustMatch } from '../../shared/workspace-trust-resolution'
import { resolveWorkspaceTrustForPath } from './workspace-trust-path-canonicalization'
import type { WorkspaceTrustStore } from './workspace-trust-service'

/**
 * 'created' never crosses the `workspaceTrust:resolveIntake` IPC channel (slice 2a) — the
 * `repos:create` handler writes trust in-process from this same-named literal and never calls
 * this resolver. Kept in the union so the type documents every intake path, not because this
 * function branches on it: the three-way table below is identical for every provenance value.
 */
export type WorkspaceTrustIntakeProvenance = 'created' | 'added' | 'cloned' | 'folder-workspace'

export type WorkspaceTrustIntakeResolution =
  | { outcome: 'inherit-trusted'; inheritedFrom: string }
  | { outcome: 'already-declined'; declinedEntryId: string }
  | { outcome: 'prompt'; reason: 'no-decision' | 'ancestor-declined'; ancestorPath?: string }

/**
 * The single choke point both `Repo.path` and `FolderWorkspace.folderPath` intake resolve
 * through (Req: Both Intake Choke Points Share the Predicate). A decline never suppresses the
 * prompt for a new descendant path (Req: A Declined Ancestor Does Not Suppress the Prompt) —
 * only the exact same path stays silently declined.
 */
export async function resolveWorkspaceTrustIntake(
  path: string,
  store: WorkspaceTrustStore,
  _provenance: WorkspaceTrustIntakeProvenance
): Promise<WorkspaceTrustIntakeResolution> {
  const entries = store.getSettings().workspaceTrustEntries ?? []
  const match = resolveWorkspaceTrustMatch(path, entries)
  if (!match) {
    return { outcome: 'prompt', reason: 'no-decision' }
  }
  if (match.entry.trusted) {
    // Phase-2 re-verify before ever claiming inherit-trusted, so this outcome never disagrees
    // with what the gate itself would answer for the same path.
    const verified = await resolveWorkspaceTrustForPath(path, entries)
    if (!verified) {
      return { outcome: 'prompt', reason: 'no-decision' }
    }
    return { outcome: 'inherit-trusted', inheritedFrom: match.entry.path }
  }
  if (match.matchKind === 'exact') {
    return { outcome: 'already-declined', declinedEntryId: match.entry.id }
  }
  return { outcome: 'prompt', reason: 'ancestor-declined', ancestorPath: match.entry.path }
}
