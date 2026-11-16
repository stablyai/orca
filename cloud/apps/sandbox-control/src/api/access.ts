// Per-member workspace access for the public API and MCP, the same rule as the desktop registry
// (src/workspaces.ts canSee/canOpen): a workspace belongs to its owner and is never shared. Being in the same
// org is never enough.
//   read     status/list metadata              owner · org admin (metadata only)
//   open     sessions list, messages, wake      owner, not archived
//   owner    session screens, unarchive        owner only
//   manage   sleep, archive, destroy           owner · org admin
// API keys, OAuth tokens and workspace tokens all act as the member who created them.
import { canOpen as w4CanOpen, canSee as w4CanSee, isOrgAdmin as w4IsOrgAdmin, isOwner } from '../workspaces'
import { ApiError, type ApiCaller } from './caller'
import type { WorkspaceRow } from './workspaces'

export type WorkspaceAction = 'read' | 'open' | 'owner' | 'manage'

export function isOrgAdmin(caller: ApiCaller): boolean {
  return w4IsOrgAdmin(caller)
}

export function isWorkspaceOwner(caller: ApiCaller, row: WorkspaceRow): boolean {
  return isOwner(caller, row)
}

/** In-VM tokens see their own VM and the siblings it created, nothing else. */
function withinTokenReach(caller: ApiCaller, row: WorkspaceRow): boolean {
  return caller.via !== 'workspace' || row.id === caller.sandboxId || row.origin_ref === caller.sandboxId
}

/** The registry's rule: the owner only. */
export function canSee(caller: ApiCaller, row: WorkspaceRow): boolean {
  return withinTokenReach(caller, row) && w4CanSee(caller, row)
}

export function allowed(caller: ApiCaller, row: WorkspaceRow, action: WorkspaceAction): boolean {
  const adminMetadata = caller.via !== 'workspace' && row.account_id === caller.accountId && isOrgAdmin(caller)
  switch (action) {
    case 'read':
      return canSee(caller, row) || adminMetadata
    case 'open':
      return withinTokenReach(caller, row) && w4CanOpen(caller, row)
    case 'owner':
      return isWorkspaceOwner(caller, row) && canSee(caller, row)
    case 'manage':
      return (isWorkspaceOwner(caller, row) && canSee(caller, row)) || adminMetadata
  }
}

/** 404 when the caller may not even know it exists, 403 when it may see but not do this. */
export function authorize(caller: ApiCaller, row: WorkspaceRow, action: WorkspaceAction): void {
  if (!allowed(caller, row, 'read')) {
    throw new ApiError(404, 'not_found')
  }
  if (!allowed(caller, row, action)) {
    throw new ApiError(403, 'forbidden', action === 'owner' ? 'owner_only' : 'not_allowed')
  }
}
