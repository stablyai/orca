import type { RecipeEnvironmentDescription } from '../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'
import type { MobileRelayServerWorktreeRow } from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { isWorkspaceOwnedBySomeoneElse } from '../../../shared/workspace-view/workspace-creator-visibility'
import { worktreeIdentityKey } from '../../../shared/worktree/id'

/** Only this desktop knows which workspaces live on VMs it created; the server's rows can't say. */
export function stampRecipeEnvironment(
  row: MobileRelayServerWorktreeRow,
  recipeEnvironments: ReadonlyMap<string, RecipeEnvironmentDescription> | undefined
): MobileRelayServerWorktreeRow {
  const environment =
    typeof row.worktreeId === 'string' ? recipeEnvironments?.get(row.worktreeId) : undefined
  if (environment) {
    return { ...row, recipeEnvironment: environment }
  }
  // Only this desktop may say a row's VM is its own; drop the field if the server sent one.
  if ('recipeEnvironment' in row) {
    const { recipeEnvironment: _serverClaim, ...rest } = row
    return { ...rest, hostId: row.hostId }
  }
  return row
}

/** Stamp desktop-only knowledge: mark other-client rows without dropping them, and include browser/chat activity. */
export function stampDesktopSidebarView(
  row: MobileRelayServerWorktreeRow,
  environmentId: string,
  desktopDeviceIds: ReadonlyMap<string, string>,
  sessionActivity: ReadonlySet<string>
): MobileRelayServerWorktreeRow {
  const otherClient = isWorkspaceOwnedBySomeoneElse(
    { creatorProvenance: row.creatorProvenance, runtimeOwnerEnvironmentId: environmentId },
    desktopDeviceIds
  )
  const active =
    typeof row.worktreeId === 'string' && sessionActivity.has(worktreeIdentityKey(row.worktreeId))
  if (!otherClient && !active) {
    return row
  }
  return {
    ...row,
    ...(otherClient ? { desktopOtherClient: true } : {}),
    ...(active ? { hasHostSidebarActivity: true } : {})
  }
}
