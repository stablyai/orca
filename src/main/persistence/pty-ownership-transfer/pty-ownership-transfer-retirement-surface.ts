import type { Store } from '../loading-store/store'
import type { PtyOwnershipModelRetirement } from './pty-ownership-transfer-model-retirement'
import { ownershipTransferSurfaceOwnerKey } from '../loading-store/pty-ownership-transfer-surface-persistence'
import { retireTerminalSurfaceFromPersistence } from '../../runtime/mobile-session-terminal-persistence-retirement'

type RetirementStore = Pick<Store, 'getWorkspaceSession' | 'setWorkspaceSession' | 'flushOrThrow'>

/** The caller owns the validated retirement receipt; this only certifies its workspace cleanup. */
export function persistPtyOwnershipRetirementSurface(
  store: RetirementStore,
  retirement: PtyOwnershipModelRetirement
): void {
  const { identity, surfaceBinding: binding } = retirement.event
  if (binding.executionHostId !== 'local' || binding.ptyId !== identity.terminalId) {
    throw new Error('pty_ownership_transfer_retirement_surface_invalid')
  }
  const worktreeId = ownershipTransferSurfaceOwnerKey(binding.workspaceKey)
  const original = store.getWorkspaceSession(binding.executionHostId)
  const paneKey = `${binding.tabId}:${binding.leafId}`
  const layout = original.terminalLayoutsByTabId[binding.tabId]
  const incarnation = original.terminalPtyIncarnationsByPaneKey?.[paneKey]
  const ptyId = layout?.ptyIdsByLeafId?.[binding.leafId]
  const legacyPtyId = !layout
    ? original.tabsByWorktree[worktreeId]?.find((tab) => tab.id === binding.tabId)?.ptyId
    : undefined
  if (
    (incarnation === identity.incarnationId && ptyId && ptyId !== identity.terminalId) ||
    (!incarnation && (ptyId === identity.terminalId || legacyPtyId === identity.terminalId))
  ) {
    throw new Error('pty_ownership_transfer_retirement_surface_unverifiable')
  }
  const next =
    incarnation === identity.incarnationId
      ? retireTerminalSurfaceFromPersistence(original, {
          worktreeId,
          parentTabId: binding.tabId,
          leafId: binding.leafId,
          ptyId: identity.terminalId,
          incarnationId: identity.incarnationId
        })
      : original
  if (next !== original) {
    store.setWorkspaceSession(next, binding.executionHostId)
  }
  // Keep the receipt pending on failure; topology fences forbid rollback resurrection.
  store.flushOrThrow()
  if (
    store.getWorkspaceSession(binding.executionHostId).terminalPtyIncarnationsByPaneKey?.[
      paneKey
    ] === identity.incarnationId
  ) {
    throw new Error('pty_ownership_transfer_retirement_surface_unverified')
  }
}
