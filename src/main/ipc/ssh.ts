import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshRelayAiVaultHostInfo } from '../ssh/ssh-relay-session'
import type {
  SshAiVaultRelayListParams,
  SshAiVaultRelayTitleParams
} from '../../shared/ssh-ai-vault-relay'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import {
  getSshTargetRegistryStore,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../ssh/ssh-target-registry'

// Why re-exported: the registry moved to ../ssh/ssh-target-registry so the runtime can
// read it without pulling ipcMain in, but many existing importers reference these from
// here. Re-exporting keeps them working without a repo-wide rename.
export {
  connectRegisteredSshTarget,
  getActiveMultiplexer,
  getRegisteredSshState,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../ssh/ssh-target-registry'
import { registerSshBrowseHandler } from './ssh-browse'
import { registerCredentialHandler } from './ssh-passphrase'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  initializeSshConnectionGenerationSession,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  registerAdvertisedUrlRefresh,
  unregisterAdvertisedUrlRefresh
} from './ssh-advertised-url-refresh'
import {
  connectInFlight,
  credentialRequestedForTarget,
  pendingTransportReconnects,
  resetRelayInFlight,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'
import { registerSshConnectionHandlers } from './ssh-connection-handlers'
import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'
import {
  connectionManager,
  getCurrentMainWindow,
  portForwardManager,
  setConnectionManager,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from './ssh-ipc-context'
import { registerSshPortForwardHandlers } from './ssh-port-forward-handlers'
import { persistPortForwardsWithUnrestored } from './ssh-port-forward-persistence'
import { clearRelayLostBackoff, relayLostBackoff } from './ssh-relay-lost-backoff'
import { refreshActiveRelaySessions } from './ssh-relay-session-callbacks'
import { broadcastPortForwards, relayStateOverrides } from './ssh-renderer-broadcast'
import { resetSshShutdownDrain } from './ssh-shutdown-drain'
import { registerSshTargetCrudHandlers } from './ssh-target-crud-handlers'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'

const SSH_IPC_CHANNELS = [
  'ssh:listTargets',
  'ssh:listRemovedTargetLabels',
  'ssh:addTarget',
  'ssh:updateTarget',
  'ssh:removeTarget',
  'ssh:importConfig',
  'ssh:listConfigHosts',
  'ssh:resolveConfigHost',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:terminateSessions',
  'ssh:resetRelay',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listDetectedPorts'
] as const

export function getActiveSshAiVaultHostInfo(targetId: string): SshRelayAiVaultHostInfo | null {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  return activeSessions.get(targetId)?.getAiVaultHostInfo() ?? null
}

export function getActiveSshAiVaultHostInfos(): SshRelayAiVaultHostInfo[] {
  return [...activeSessions.values()].flatMap((session) => {
    if (isRuntimeOwnedSshTargetId(session.targetId)) {
      return []
    }
    const info = session.getAiVaultHostInfo()
    return info ? [info] : []
  })
}

export async function requestActiveSshAiVaultSessionList(
  targetId: string,
  params: SshAiVaultRelayListParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionList(params, options)
}

export async function requestActiveSshAiVaultSessionTitles(
  targetId: string,
  params: SshAiVaultRelayTitleParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionTitles(params, options)
}

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  initializeSshConnectionGenerationSession()
  // Why: macOS re-activation re-calls this with a new BrowserWindow; ipcMain.handle() throws on a duplicate channel, so remove prior handlers first.
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  setCurrentGetMainWindow(getMainWindow)
  setCurrentRuntime(runtime)
  setSshTargetRegistryStore(new SshConnectionStore(store))
  setPersistedStore(store)
  registerAdvertisedUrlRefresh(getCurrentMainWindow)

  registerCredentialHandler(getCurrentMainWindow)

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    setConnectionManager(new SshConnectionManager(callbacks))
  }
  setPortForwardManager(portForwardManager ?? new SshPortForwardManager())
  portForwardManager!.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
      }
      persistPortForwardsWithUnrestored(entry.connectionId)
      broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    }
  })
  refreshActiveRelaySessions()
  registerPowerMonitorReconnect()
  registerSshBrowseHandler(() => connectionManager)

  registerSshTargetCrudHandlers()
  registerSshConnectionHandlers()
  registerSshPortForwardHandlers()

  return {
    connectionManager: connectionManager!,
    sshStore: getSshTargetRegistryStore() as SshConnectionStore
  }
}

export function getSshConnectionManager(): SshConnectionManager | null {
  return connectionManager
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  unregisterAdvertisedUrlRefresh()
  unregisterPowerMonitorReconnect()
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.removeHandler('ssh:submitCredential')

  // Why: allSettled — a rejected disposal write must not abort the rest of the reset and leak state into the next test.
  await Promise.allSettled(
    [...activeSessions.values()].map((session) => session.disposeAndPersist())
  )
  activeSessions.clear()
  for (const targetId of relayLostBackoff.keys()) {
    clearRelayLostBackoff(targetId)
  }
  relayStateOverrides.clear()
  connectInFlight.clear()
  targetLifecycleInFlight.clear()
  pendingTransportReconnects.clear()
  resetSshConnectionGenerations()
  resetSshProviderAuthorities()
  resetRelayInFlight.clear()
  testingTargets.clear()
  testConnectionProbes.clear()
  credentialRequestedForTarget.clear()
  quitTeardownStartGate.resetForTests()
  resetSshShutdownDrain()

  await connectionManager?.disconnectAll()
  portForwardManager?.dispose()
  setConnectionManager(null)
  setPortForwardManager(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setCurrentGetMainWindow(() => null)
  setCurrentRuntime(undefined)
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
