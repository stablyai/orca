import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import {
  startupDraftPath,
  writeStoredStartupDraft
} from '../../../runtime/workspaces/startup/worktree-startup-drafts'

type LegacyDraftMeta = WorktreeMeta & {
  blockedStartupDraft?: { text?: unknown; outcome?: unknown }
}

/** Move draft bytes before dropping the copy from the old metadata domains. */
export function migrateLegacyStartupDrafts(state: PersistedState, profile: string): boolean {
  let changed = false
  const migrate = (worktreeId: string, meta: LegacyDraftMeta | undefined): void => {
    if (!meta || !Object.hasOwn(meta, 'blockedStartupDraft')) {
      return
    }
    const { blockedStartupDraft: draft, instanceId, hostId } = meta
    if (
      (!hostId || hostId === LOCAL_EXECUTION_HOST_ID) &&
      instanceId &&
      draft?.outcome === 'not-delivered' &&
      typeof draft.text === 'string'
    ) {
      const file = startupDraftPath(profile, worktreeId, instanceId)
      try {
        if (!existsSync(file)) {
          writeStoredStartupDraft(file, {
            id: randomUUID(),
            instanceId,
            worktreeId,
            outcome: 'not-delivered',
            text: draft.text
          })
        }
      } catch {
        console.warn('[worktree-create] could not migrate the saved startup draft')
        return
      }
    }
    delete meta.blockedStartupDraft
    changed = true
  }

  for (const [alias, identities] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (
      identities.length === 1 &&
      getExecutionHostIdFromWorktreeHostIdentity(alias) === LOCAL_EXECUTION_HOST_ID
    ) {
      migrate(getWorktreeIdFromHostIdentity(alias), state.worktreeMetaByIdentity?.[identities[0]!])
    }
  }
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    migrate(worktreeId, meta)
  }
  return changed
}
