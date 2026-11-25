import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  listEnvironments,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL,
  type RuntimeEnvironmentPortForwardsChanged
} from '../../../../shared/remote-runtime/host-catalog/runtime-environment-port-forward-channel'
import {
  addPairedPortForward,
  closePairedPortForwards,
  configurePairedPortForwards,
  ensurePairedPortForward,
  listPairedPortForwards,
  pairedPortForwardEnvironmentIds,
  removePairedPortForward,
  resetPairedPortForwardTunnel,
  updatePairedPortForward
} from '../../../ports/paired-forwards/paired-port-forwards'
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

/** Forwards are made only from this renderer's gestures; paired servers and agents have no route here. */
export function registerRuntimeEnvironmentPortForwardHandlers(options: {
  getUserDataPath: () => string
}): void {
  configurePairedPortForwards({
    resolveConnection: async (environmentId) => {
      if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
        throw new Error(runtimeEnvironmentManualDisconnectReason(environmentId))
      }
      const environment = await resolveEnvironment(options.getUserDataPath(), environmentId)
      return getPreferredPairedRuntimeConnection(environment)
    },
    onChanged: publishPortForwardsChanged
  })
  handleRuntimeEnvironmentChannel('runtimeEnvironments:listPortForwards', () =>
    listPairedPortForwards()
  )
  handleRuntimeEnvironmentChannel('runtimeEnvironments:addPortForward', (_event, input: unknown) =>
    addPairedPortForward(ForwardSpec.parse(input))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:updatePortForward',
    (_event, input: unknown) =>
      updatePairedPortForward(ForwardSpec.extend({ id: z.string().min(1).max(64) }).parse(input))
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:removePortForward',
    (_event, input: unknown) =>
      removePairedPortForward(z.object({ id: z.string().min(1).max(64) }).parse(input).id)
  )
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:ensurePortForward',
    (_event, input: unknown) =>
      ensurePairedPortForward(
        z.object({ environmentId: EnvironmentId, remotePort: Port, label: Label }).parse(input)
      )
  )
}

/** The CLI can remove a pairing from the registry directly; its forwards stop listening here too. */
export async function closePortForwardsOfRemovedEnvironments(userDataPath: string): Promise<void> {
  const forwardedIds = pairedPortForwardEnvironmentIds()
  if (forwardedIds.length === 0) {
    return
  }
  try {
    const known = new Set(
      (await listEnvironments(userDataPath)).map((environment) => environment.id)
    )
    await Promise.all(
      forwardedIds.filter((id) => !known.has(id)).map((id) => closePairedPortForwards(id))
    )
  } catch (error) {
    console.warn("[runtime-environments] Closing removed servers' forwards failed:", error)
  }
}

function publishPortForwardsChanged(environmentId: string): void {
  const payload: RuntimeEnvironmentPortForwardsChanged = {
    environmentId,
    forwards: listPairedPortForwards(environmentId)
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
