// Relay ownership is main's record of the desktop window's writes; a window save never authors it.

import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

export type WindowSessionSetOptions = {
  /** The window sends its relay ids by ownership (carried, or session:apply-desktop-relays); keep the stored ones. */
  relays?: 'separate'
  /** This partition's relay ids; parsed by the handler. */
  carried?: unknown
}

export function windowSaveKeepingRelayOwnership<
  T extends WorkspaceSessionState | WorkspaceSessionPatch
>(
  stored: WorkspaceSessionState,
  save: T,
  kind: 'set' | 'patch',
  options?: WindowSessionSetOptions
): T {
  const relaysSeparate = kind === 'set' && options?.relays === 'separate'
  if (
    kind === 'patch' &&
    !Object.hasOwn(save, 'desktopRelayOwnerByTabId') &&
    !Object.hasOwn(save, 'desktopRelayAdoptionVersion')
  ) {
    return save
  }
  const {
    desktopRelayOwnerByTabId: _authoredOwners,
    desktopRelayAdoptionVersion: _authoredVersion,
    ...rest
  } = save
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same save with the relay fields replaced by their stored values.
  return {
    ...rest,
    ...(relaysSeparate ? { remoteSessionIdsByTabId: stored.remoteSessionIdsByTabId } : {}),
    ...(kind === 'set' || stored.desktopRelayOwnerByTabId
      ? { desktopRelayOwnerByTabId: stored.desktopRelayOwnerByTabId }
      : {}),
    ...(kind === 'set' || stored.desktopRelayAdoptionVersion !== undefined
      ? { desktopRelayAdoptionVersion: stored.desktopRelayAdoptionVersion }
      : {})
  } as T
}
