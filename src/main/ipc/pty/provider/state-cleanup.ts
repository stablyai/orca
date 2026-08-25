import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { unregisterPty } from '../../../memory/pty-registry'
import { markClaudePtyExited } from '../../../claude-accounts/live-pty-gate'
import { forgetCodexPaneAccount } from '../../../codex/codex-pane-account-registry'
import { openCodeHookService } from '../../../opencode/hook-service'
import { piTitlebarExtensionService } from '../../../pi/titlebar-extension-service'
import { agentHookServer } from '../../../agent-hooks/server'
import { clearMigrationUnsupportedPty } from '../../../agent-hooks/migration-unsupported-pty-state'
import { clearNativeWindowsConptyPty } from '../../../runtime/terminal-model-query-authority'
import {
  clearHiddenRendererPtyDeliveryState,
  isHiddenRendererPty
} from '../../pty-hidden-delivery-gate'
import { agentSessionOwners } from '../pane/agent-session-owners'
import { paneKeyPtyId, paneKeyTeardownListeners, ptyPaneKey } from '../pane/key-state'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'
import { clearBackgroundedDeliverySyncForPty } from './listener-lifecycle'
import {
  activeRendererPtys,
  deliveredHiddenRendererResizeOutputPtys,
  interactiveOutputCharsByPty,
  invalidatePendingPtyDrainPolicy,
  invalidatePendingPtyDrainPriority,
  lastInputAtByPty,
  pendingHiddenRendererResizeOutputPtys,
  providerSnapshotRequiredPtys,
  ptySizes,
  rendererVisibilityKnownPtys,
  visibleRendererPtys
} from '../delivery/visibility-state'

/**
 * Tear down per-PTY provider-scoped state.
 *
 * Claimed agent owners remain fenced because the relay process may survive and
 * prove the exact same generation after reconnect.
 */
export function clearProviderPtyState(
  id: string,
  opts: { preserveAgentSessionOwners?: boolean } = {}
): void {
  if (!opts.preserveAgentSessionOwners) {
    agentSessionOwners.release(id)
    // Why: the launch-account record outlives the app, so only a real teardown
    // may drop it — a disconnect that can reconnect is not a death, and a reused
    // id must never inherit a dead pane's Codex account.
    forgetCodexPaneAccount(id)
  }
  // Why: OpenCode and Pi both allocate PTY-scoped runtime state outside the
  // node-pty process table. Centralizing provider cleanup avoids drift where a
  // new teardown path forgets to remove one provider's overlay/hook state.
  openCodeHookService.clearPty(id)
  piTitlebarExtensionService.clearPty(id)
  // Why: SSH exit/teardown paths bypass pty.ts's local onExit but still must release Claude account-switch guards.
  markClaudePtyExited(id)
  ptySizes.delete(id)
  ptyIncarnationById.delete(id)
  lastInputAtByPty.delete(id)
  interactiveOutputCharsByPty.delete(id)
  const activeChanged = activeRendererPtys.delete(id)
  visibleRendererPtys.delete(id)
  rendererVisibilityKnownPtys.delete(id)
  pendingHiddenRendererResizeOutputPtys.delete(id)
  deliveredHiddenRendererResizeOutputPtys.delete(id)
  // Why: every teardown path funnels through here — hidden/interest gate bits must not outlive the PTY or a reused map entry could silently gate a new one.
  const deliveryPolicyChanged = isHiddenRendererPty(id)
  clearHiddenRendererPtyDeliveryState(id)
  if (activeChanged) {
    invalidatePendingPtyDrainPriority(id, false)
  }
  if (deliveryPolicyChanged) {
    invalidatePendingPtyDrainPolicy(id, false)
  }
  clearBackgroundedDeliverySyncForPty(id)
  providerSnapshotRequiredPtys.delete(id)
  // Why: the Phase-5 ConPTY DA1 spawn record must not leak onto a reused id.
  clearNativeWindowsConptyPty(id)
  const paneKey = ptyPaneKey.get(id)
  const stillOwnsPaneKey = paneKey ? paneKeyPtyId.get(paneKey) === id : false
  // Why: drop the memory-collector registration so a dead PTY doesn't resolve its dead pid on every snapshot; no-op for never-registered (SSH-owned) PTYs.
  unregisterPty(id)
  // Why: cover paths that bypass runtime.onPtyExit (SSH reattach/shutdown, daemon spawn-failure) — else the watcher's per-PTY buffer and worktree binding outlive the PTY.
  advertisedUrlWatcher.unbindPty(id)
  clearMigrationUnsupportedPty(id)
  agentHookServer.clearPaneKeyAliasesForPty(id, {
    shouldClearStablePaneKey: (stablePaneKey) => {
      // Why: when this PTY never rebuilt ptyPaneKey after restart, alias ownership is our only proof — don't erase a newer PTY that now owns the same stable paneKey.
      const stablePaneOwner = paneKeyPtyId.get(stablePaneKey)
      if (stablePaneOwner && stablePaneOwner !== id) {
        return false
      }
      return !paneKey || (stillOwnsPaneKey && stablePaneKey === paneKey)
    }
  })
  // Why: clear the hook server's per-paneKey caches (via the spawn-time paneKey mapping, its only ptyId→paneKey correlation) so dead panes don't accumulate over process lifetime.
  if (paneKey) {
    if (stillOwnsPaneKey) {
      agentHookServer.clearPaneState(paneKey)
      paneKeyPtyId.delete(paneKey)
    }
    ptyPaneKey.delete(id)
    if (stillOwnsPaneKey) {
      // Why: notify AFTER dropping the paneKey↔ptyId entries so a listener re-reading the map sees post-teardown state; wrap each so one throw can't block the rest.
      for (const listener of paneKeyTeardownListeners) {
        try {
          listener(paneKey)
        } catch (err) {
          console.error('[pty] paneKey teardown listener threw', err)
        }
      }
    }
  }
}

export function clearPtyOwnershipForConnection(connectionId: string): void {
  for (const [ptyId, connId] of ptyOwnership) {
    if (connId === connectionId) {
      // Why: pane-scoped caches cannot route while disconnected, but claimed
      // ownership must survive until reconnect makes absence authoritative.
      clearProviderPtyState(ptyId, { preserveAgentSessionOwners: true })
      ptyOwnership.delete(ptyId)
    }
  }
}
