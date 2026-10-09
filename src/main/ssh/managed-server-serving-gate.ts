/** Whether a connect's serving check ends it, or lets the update check run (and redeploy). */
import type { HostServerUpdateOnConnect } from './managed-server-update-check'
import {
  MANAGED_ORCAD_FENCED_DETAIL,
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL,
  type OrcadManagedServing
} from './orcad-managed-serving'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type ManagedRoute = Extract<HostServerOnConnectResult, { route: 'managed' }>

/**
 * The managed result for a server that is not serving, or null when the update check runs next.
 * A host with no active version (another desktop stopped it) goes on to the update, which
 * redeploys this desktop's still-linked server instead of leaving it stranded.
 */
export function unservedManagedResult(
  environmentId: string,
  serving: OrcadManagedServing
): ManagedRoute | null {
  if (serving.state !== 'unverifiable' || serving.detail === MANAGED_ORCAD_NOT_ACTIVATED_DETAIL) {
    return null
  }
  // Still the managed route: a stopped server says nothing about the host's terminals.
  return {
    route: 'managed',
    environmentId,
    serving,
    ...(serving.detail === MANAGED_ORCAD_FENCED_DETAIL ? { fenceHeld: true as const } : {})
  }
}

/** Keeps the "not activated" note when the update did not bring a server back. */
export function managedResultAfterUpdate(
  environmentId: string,
  serving: OrcadManagedServing,
  { note, reason, fenceBusy }: HostServerUpdateOnConnect
): ManagedRoute {
  return {
    route: 'managed',
    environmentId,
    ...(note ? { update: note } : {}),
    ...(serving.state === 'unverifiable' && reason !== 'updated' ? { serving } : {}),
    ...(fenceBusy ? { fenceHeld: true as const } : {})
  }
}
