// Relay ownership is main's record of the desktop window's writes; a window save never authors it.

import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

export type WindowSessionSetOptions = {
  /** The window sends its relay ids through session:apply-desktop-relays; keep the stored ones. */
  relays?: 'separate'
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
  if (kind === 'patch' && !Object.hasOwn(save, 'desktopRelayOwnership')) {
    return save
  }
  const { desktopRelayOwnership: _authored, ...rest } = save
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same save with the two relay fields replaced by their stored values.
  return {
    ...rest,
    ...(relaysSeparate ? { remoteSessionIdsByTabId: stored.remoteSessionIdsByTabId } : {}),
    ...(kind === 'set' || stored.desktopRelayOwnership
      ? { desktopRelayOwnership: stored.desktopRelayOwnership }
      : {})
  } as T
}
