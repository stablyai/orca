import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL,
  type RuntimeEnvironmentPortForwardsChanged
} from '../../../../shared/remote-runtime/host-catalog/runtime-environment-port-forward-channel'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import type { Store } from '../../../persistence/loading-store/store'
import {
  addPairedPortForward,
  closePairedPortForwards,
  configurePairedPortForwards,
  ensurePairedPortForward,
  forgetPairedPortForwards,
  listPairedPortForwards,
  pairedPortForwardEnvironmentIds,
  removePairedPortForward,
  resetPairedPortForwardTunnel,
  restorePairedPortForwards,
  updatePairedPortForward
} from '../../../ports/paired-forwards/paired-port-forwards'
import {
  restoredPairedPortForwardMovesPending,
  takeRestoredPairedPortForwardMoves
} from '../../../ports/paired-forwards/paired-port-forward-saved'
import { onRuntimeEnvironmentStatusPublished } from '../status/runtime-environment-status-owner'
import { trackRuntimeEnvironmentVerifiedTransitions } from '../status/runtime-environment-verified-transitions'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  runtimeEnvironmentManualDisconnectReason
} from '../connectivity/runtime-environment-manual-disconnect'
import { onRuntimeEnvironmentTransportGenerationRetired } from '../connections/runtime-environment-transport-generation'

const Port = z.number().int().min(1).max(65_535)
const EnvironmentId = z.string().trim().min(1).max(256)
const Label = z.string().max(256).optional()
const ForwardSpec = z.object({
  environmentId: EnvironmentId,
  localPort: Port,
  remoteHost: z.string().max(256),
  remotePort: Port,
  label: Label
})

// A person's disconnect stops the server's forwards; a transport swap only redials them.
onRuntimeEnvironmentTransportGenerationRetired((environmentId) => {
  if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
    void closePairedPortForwards(environmentId)
    return
  }
  resetPairedPortForwardTunnel(environmentId)
})

// One restore pass each time a server comes back; an older server without forwarding restores none.
onRuntimeEnvironmentStatusPublished(
  trackRuntimeEnvironmentVerifiedTransitions((environmentId, snapshot) => {
    if (snapshot.status?.capabilities?.includes(NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY)) {
      void restorePairedPortForwards(environmentId)
    }
  })
)

/** Forwards are made only from this renderer's gestures; paired servers and agents have no route here. */
export function registerRuntimeEnvironmentPortForwardHandlers(options: {
  getUserDataPath: () => string
  store: Pick<Store, 'getPairedPortForwards' | 'setPairedPortForwards'>
}): void {
  configurePairedPortForwards({
    resolveConnection: async (environmentId) => {
      if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
        throw new Error(runtimeEnvironmentManualDisconnectReason(environmentId))
      }
      const environment = await resolveEnvironment(options.getUserDataPath(), environmentId)
      return getPreferredPairedRuntimeConnection(environment)
    },
    onChanged: publishPortForwardsChanged,
    saved: {
      all: () => options.store.getPairedPortForwards(),
      set: (environmentId, record) => options.store.setPairedPortForwards(environmentId, record)
    }
  })
  ipcMain.handle('runtimeEnvironments:listPortForwards', () => listPairedPortForwards())
  ipcMain.handle('runtimeEnvironments:addPortForward', (_event, input: unknown) =>
    addPairedPortForward(ForwardSpec.parse(input))
  )
  ipcMain.handle('runtimeEnvironments:updatePortForward', (_event, input: unknown) =>
    updatePairedPortForward(ForwardSpec.extend({ id: z.string().min(1).max(64) }).parse(input))
  )
  ipcMain.handle('runtimeEnvironments:removePortForward', (_event, input: unknown) =>
    removePairedPortForward(z.object({ id: z.string().min(1).max(64) }).parse(input).id)
  )
  ipcMain.handle('runtimeEnvironments:ensurePortForward', (_event, input: unknown) =>
    ensurePairedPortForward(
      z.object({ environmentId: EnvironmentId, remotePort: Port, label: Label }).parse(input)
    )
  )
  ipcMain.handle('runtimeEnvironments:takeRestoredPortForwardMoves', () =>
    takeRestoredPairedPortForwardMoves()
  )
}

/** The CLI can remove a pairing from the registry directly, even while this desktop is closed; its
 *  forwards stop listening here and are forgotten too. `known` is null when removal is unproven. */
export async function forgetPortForwardsOfRemovedEnvironments(
  known: ReadonlySet<string> | null
): Promise<void> {
  if (!known) {
    return
  }
  const removed = pairedPortForwardEnvironmentIds().filter((id) => !known.has(id))
  await Promise.all(removed.map((id) => forgetPairedPortForwards(id))).catch((error: unknown) => {
    console.warn("[runtime-environments] Forgetting removed servers' forwards failed:", error)
  })
}

function publishPortForwardsChanged(environmentId: string): void {
  const payload: RuntimeEnvironmentPortForwardsChanged = {
    environmentId,
    forwards: listPairedPortForwards(environmentId),
    ...(restoredPairedPortForwardMovesPending() ? { movesPending: true as const } : {})
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL, payload)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
