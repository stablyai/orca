import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { unregisterPty } from '../../../memory/pty-registry'
import { forgetCodexPaneAccount } from '../../../codex/configuration/homes/codex-pane-account-registry'
import { openCodeHookService } from '../../../opencode/status-hooks/hook-service'
import { piTitlebarExtensionService } from '../../../pi/managed-extensions/titlebar-extension-service'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { clearMigrationUnsupportedPty } from '../../../agent-hooks/observations/migration-unsupported-pty-state'
import { clearNativeWindowsConptyPty } from '../../../runtime/terminal/output/terminal-model-query-authority'
import {
  clearHiddenRendererPtyDeliveryState,
  isHiddenRendererPty
} from '../delivery/pty-hidden-delivery-gate'
import { agentSessionOwners } from '../pane/agent-session-owners'
import { paneKeyPtyId, paneKeyTeardownListeners, ptyPaneKey } from '../pane/key-state'
import { getPtyIdsForConnection, ptyIncarnationById, ptyOwnership } from './ownership-state'
import { clearBackgroundedDeliverySyncForPty } from './listener-lifecycle'
import {
  activeRendererPtys,
  interactiveOutputCharsByPty,
  invalidatePendingPtyDrainPolicy,
  invalidatePendingPtyDrainPriority,
  lastInputAtByPty,
  providerSnapshotRequiredPtys,
  ptySizes,
  rendererVisibilityKnownPtys,
  visibleRendererPtys
} from '../delivery/visibility-state'

/** Clear provider-scoped state while preserving requested claim fences across reconnect. */
export function clearProviderPtyState(
  id: string,
  opts: { preserveAgentSessionOwners?: boolean; exitProven?: true } = {}
): void {
  const paneKey = ptyPaneKey.get(id)
  const incarnationId = ptyIncarnationById.get(id)
  const existingSleep = paneKey
    ? agentHookServer.getStatusSnapshotForPane(paneKey)[0]?.paneSleep
    : undefined
  const stillOwnsPaneKey = paneKey ? paneKeyPtyId.get(paneKey) === id : false
  const preserveSleepingDone = Boolean(
    stillOwnsPaneKey &&
    paneKey &&
    ((existingSleep?.ptyId === id &&
      (!existingSleep.incarnationId ||
        !incarnationId ||
        existingSleep.incarnationId === incarnationId)) ||
      (opts.exitProven && agentHookServer.settleTerminalPaneSleep(paneKey, id, incarnationId)))
  )
  if (!opts.preserveAgentSessionOwners) {
    agentSessionOwners.release(id)
    // Persisted launch-account identity survives reconnectable disconnects, but real teardown must prevent reuse.
    forgetCodexPaneAccount(id)
  }
  // Release agent overlay/hook state even on teardown paths outside the local process table.
  openCodeHookService.clearPty(id)
  piTitlebarExtensionService.clearPty(id)
  ptySizes.delete(id)
  ptyIncarnationById.delete(id)
  lastInputAtByPty.delete(id)
  interactiveOutputCharsByPty.delete(id)
  const activeChanged = activeRendererPtys.delete(id)
  visibleRendererPtys.delete(id)
  rendererVisibilityKnownPtys.delete(id)
  // Hidden/interest state must not gate a later PTY reusing this ID.
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
  // Reused IDs must not inherit ConPTY startup-query state.
  clearNativeWindowsConptyPty(id)
  // Stop memory snapshots from resolving dead PIDs; SSH PTYs may never have registered.
  unregisterPty(id)
  // SSH reattach/shutdown and spawn failure can bypass runtime exit cleanup; unbind their URL watcher too.
  advertisedUrlWatcher.unbindPty(id)
  clearMigrationUnsupportedPty(id)
  agentHookServer.clearPaneKeyAliasesForPty(id, {
    shouldClearStablePaneKey: (stablePaneKey) => {
      if (preserveSleepingDone && stablePaneKey === paneKey) {
        return false
      }
      // Without rebuilt spawn mapping, alias ownership must protect a newer PTY on the same stable pane.
      const stablePaneOwner = paneKeyPtyId.get(stablePaneKey)
      if (stablePaneOwner && stablePaneOwner !== id) {
        return false
      }
      return !paneKey || (stillOwnsPaneKey && stablePaneKey === paneKey)
    }
  })
  // Spawn-time mapping is the hook server's only PTY-to-pane correlation; release its caches.
  if (paneKey) {
    if (stillOwnsPaneKey) {
      // Preserve proven agent-exit evidence across reconnectable disconnects.
      if (preserveSleepingDone) {
        // Its accepted row now belongs to the sleeping pane, not this retired process.
      } else if (opts.preserveAgentSessionOwners) {
        agentHookServer.clearPaneState(paneKey)
      } else {
        agentHookServer.clearPaneState(paneKey, { forgetAgentExit: true })
      }
      paneKeyPtyId.delete(paneKey)
    }
    ptyPaneKey.delete(id)
    if (stillOwnsPaneKey) {
      // Notify after removing mappings; isolate listener failures so all consumers can clean up.
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
  for (const ptyId of getPtyIdsForConnection(connectionId)) {
    // Disconnect clears unroutable pane caches while claim fences survive until authoritative reconnect.
    clearProviderPtyState(ptyId, { preserveAgentSessionOwners: true })
    ptyOwnership.delete(ptyId)
  }
}
