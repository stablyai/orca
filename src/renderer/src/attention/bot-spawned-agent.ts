import type { AppState } from '@/store/types'
import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { getBotHomes } from '../../../shared/bots/bot-homes'
import {
  agreedBotWorkspacePlace,
  botWorkspacePlace,
  type BotWorkspacePlace
} from '../../../shared/bots/bot-spawned-agent-mute'
import { getFolderWorkspaceHostIdentity } from '../../../shared/folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

const parentIndexes = new WeakMap<
  ReadonlyMap<string, readonly Worktree[]>,
  ReadonlyMap<string, string>
>()

/** Child identity to the identity of the row the sidebar nests it under, built once per children map. */
function parentIdentityIndex(
  childrenByParent: ReadonlyMap<string, readonly Worktree[]>
): ReadonlyMap<string, string> {
  const cached = parentIndexes.get(childrenByParent)
  if (cached) {
    return cached
  }
  const index = new Map<string, string>()
  for (const [parent, children] of childrenByParent) {
    for (const child of children) {
      index.set(getWorktreeHostIdentity(child), parent)
    }
  }
  parentIndexes.set(childrenByParent, index)
  return index
}

/** Where an alerting workspace sits among this computer's bots, by the parents the sidebar draws. */
export function readBotWorkspacePlace(state: AppState, workspaceId: string): BotWorkspacePlace {
  const bots = readBotsEnabled() ? readBots() : []
  if (bots.length === 0) {
    return null
  }
  const folders = selectFolderWorkspaces(state) ?? []
  const homes = new Set(
    getBotHomes(bots, folders).map(({ home }) => getFolderWorkspaceHostIdentity(home))
  )
  if (homes.size === 0) {
    return null
  }
  const parents = parentIdentityIndex(
    selectSidebarChildrenByParentIdentity(state, readRuntimeStatuses())
  )
  const identities = [
    ...folders
      .filter((folder) => folderWorkspaceKey(folder.id) === workspaceId)
      .map(getFolderWorkspaceHostIdentity),
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state))
      .filter((worktree) => worktree.id === workspaceId)
      .map(getWorktreeHostIdentity)
  ]
  return agreedBotWorkspacePlace(
    identities.map((identity) => botWorkspacePlace(identity, (child) => parents.get(child), homes))
  )
}
