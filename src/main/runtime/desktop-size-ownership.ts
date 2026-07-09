// Why: shared PTYs can be rendered by multiple desktop clients (host + remote
// Orca windows). Without arbitration, each client's safeFit/reassertion path
// races to write cols/rows and the last writer wins — a permanent tug-of-war.
// Size ownership is sticky: the controlling client owns the PTY grid; non-owners
// park their xterm at the owner's size and must not reassert. See multi-client
// desktop PTY size brief (2026-07-09).

export const LOCAL_DESKTOP_CLIENT_ID = 'local'

export type DesktopSizeOwner = {
  clientId: string
  cols: number
  rows: number
  updatedAt: number
}

/** Wire + renderer modes for the fit-hold overlay / park signal. */
export type TerminalFitHoldMode = 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'

/**
 * What fit-hold a viewer should apply for the current owner.
 * Owners get `desktop-fit` (no park); non-owners park at the owner's grid.
 */
export function fitHoldModeForViewer(ownerClientId: string, viewerClientId: string): TerminalFitHoldMode {
  return ownerClientId === viewerClientId ? 'desktop-fit' : 'remote-desktop-fit'
}

/** Host Electron renderer is the local owner; everyone else is a remote viewer. */
export function fitHoldModeForLocalHost(ownerClientId: string): TerminalFitHoldMode {
  return fitHoldModeForViewer(ownerClientId, LOCAL_DESKTOP_CLIENT_ID)
}

export function isLocalDesktopOwner(ownerClientId: string | null | undefined): boolean {
  return ownerClientId == null || ownerClientId === LOCAL_DESKTOP_CLIENT_ID
}
