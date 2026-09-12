import type { OrcadMigrationClientHostedBrowserCloseIntent } from '../../../shared/orcad-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export function collectCloseIntents(
  state: PersistedState,
  scope: OrcadMigrationSourceScope,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined,
  onBlocked: () => void
): OrcadMigrationClientHostedBrowserCloseIntent[] | undefined {
  const eligiblePages = new Set<string>()
  for (const [ownerKey, pages] of Object.entries(
    eligibleSession?.clientHostedBrowserPagesByWorktree ?? {}
  )) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    const worktreeId = unqualifyOrcadMigrationOwnerKey(ownerKey)
    for (const page of pages) {
      eligiblePages.add(`${worktreeId}\0${page.browserPageId}`)
    }
  }
  const result: OrcadMigrationClientHostedBrowserCloseIntent[] = []
  const seen = new Set<string>()
  const sessions = [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {}).flatMap((entry) =>
      entry ? [entry] : []
    )
  ].filter((entry): entry is WorkspaceSessionState => Boolean(entry))
  for (const session of sessions) {
    for (const [sourceEnvironmentId, intents] of Object.entries(
      session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
    )) {
      // Intents already keyed to the destination were handled by a prior retry.
      if (sourceEnvironmentId === destinationEnvironmentId) {
        continue
      }
      for (const intent of intents) {
        if (!orcadMigrationOwnerMatchesScope(intent.worktreeId, scope)) {
          continue
        }
        const worktreeId = unqualifyOrcadMigrationOwnerKey(intent.worktreeId)
        const key = `${sourceEnvironmentId}\0${intent.browserPageId}\0${worktreeId}`
        if (
          !eligiblePages.has(`${worktreeId}\0${intent.browserPageId}`) ||
          !destinationEnvironmentId
        ) {
          onBlocked()
          continue
        }
        if (seen.has(key)) {
          onBlocked()
          continue
        }
        seen.add(key)
        result.push({
          sourceEnvironmentId,
          browserPageId: intent.browserPageId,
          worktreeId,
          closedAt: intent.closedAt
        })
      }
    }
  }
  return result.length > 0 ? result : undefined
}
