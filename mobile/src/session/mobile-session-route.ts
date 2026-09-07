import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

export type MobileSessionRouteParams = {
  hostId: string
  worktreeId: string
  name?: string
}

/** Identities stay raw — the navigator owns the params, so pre-encoding a
 *  workspace id would reach the session screen still escaped. */
export function mobileSessionRouteTarget({
  hostId,
  worktreeId,
  name
}: MobileSessionRouteParams): HostStackRouteTarget {
  return {
    name: '[hostId]/session/[worktreeId]',
    params: name ? { hostId, worktreeId, name } : { hostId, worktreeId }
  }
}
