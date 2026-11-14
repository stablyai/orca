import {
  manuallyDisconnectedResponse,
  runtimeEnvironmentCallFailure
} from '../requests/runtime-environment-call-failure'
import { desktopChatCreationHistory } from '../../../runtime/client/navigation/desktop-chat-creation-history'
import { ipcMain } from 'electron'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment,
  type RuntimeEnvironmentRemoval
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  connectThroughOwningService,
  removeThroughOwningService
} from './runtime-environment-host-service-ops'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import type { Store } from '../../../persistence/loading-store/store'
import { retireRemovedRuntimeEnvironment } from '../catalog/runtime-environment-removal-cleanup'
import { removeRedundantManagedPairing } from '../catalog/runtime-environment-redundant-managed-removal'
import { readSettingsWithRuntimeEnvironmentPreference } from '../catalog/runtime-environment-preference'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from '../pairing/runtime-environment-pairing-verification'
import { publishVerifiedPairing } from '../pairing/runtime-environment-verified-pairing-publish'
import {
  closeRemoteRuntimeRequestConnection,
  getRuntimeEnvironmentStatusSnapshots
} from '../connections/runtime-environment-request-connections'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentStatus } from '../status/runtime-environment-status-probe'
import { noteRuntimeEnvironmentConnectRequested } from '../pairing/runtime-environment-pairing-refusal-registry'
import { publicRuntimeEnvironmentWithHostKey } from '../catalog/runtime-environment-host-key'
import { withWslOrcadAccountEnv } from '../../../wsl/orcad/wsl-orcad-account-env'
import { clearSshCredentialDeclinedForEnvironment } from '../../../ssh/authentication/ssh-credential-decline'
import {
  disconnectManagedHostOfEnvironmentForUser,
  disconnectRuntimeEnvironmentForUser,
  liftSshUserDisconnectForEnvironment
} from '../../ssh/ssh-host-user-disconnect'
import {
  observeWslOrcadHostResponse,
  wslOrcadHostSupports
} from '../../../wsl/orcad/wsl-orcad-host-environments'
import {
  assertWslHostReachable,
  isGatedOffWslHost
} from '../../../wsl/host-lifecycle/wsl-host-gate'
import {
  isHostSpawnFencedForWslMoveUndo,
  wslMoveUndoSpawnFencedResponse
} from '../../../persistence/moving-wsl-projects/cutover-recovery/wsl-move-undo-spawn-fence'

type ConnectivityHandlerOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

export function registerRuntimeEnvironmentConnectivityHandlers({
  store,
  getUserDataPath,
  invalidateTransport
}: ConnectivityHandlerOptions): void {
  ipcMain.handle('runtimeEnvironments:desktopCreatedChatIds', () =>
    desktopChatCreationHistory(getUserDataPath()).sessionIds()
  )
  ipcMain.handle('runtimeEnvironments:getStatusSnapshots', () =>
    getRuntimeEnvironmentStatusSnapshots()
  )
  ipcMain.handle('runtimeEnvironments:list', () => {
    const environments = listEnvironments(getUserDataPath()).filter(
      (environment) => !isGatedOffWslHost(environment)
    )
    readSettingsWithRuntimeEnvironmentPreference(store, getUserDataPath())
    return environments.map(publicRuntimeEnvironmentWithHostKey)
  })
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => {
      // An unverified code must not replace a working pairing.
      const environment = addEnvironmentFromPairingCode(getUserDataPath(), args)
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      return { environment: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:verifyAndAddFromPairingCode',
    async (_event, args: { name: string; pairingCode: string; allowLoopback?: boolean }) => {
      const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        await publishVerifiedPairing(
          getUserDataPath(),
          result,
          result.updatedExisting ? { invalidateTransport } : null
        )
      }
      return result
    }
  )
  ipcMain.handle('runtimeEnvironments:resolve', (_event, args: { selector: string }) =>
    redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (
      _event,
      args: { selector: string }
    ): RuntimeEnvironmentRemoval | Promise<RuntimeEnvironmentRemoval> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (store.getSettings().activeRuntimeEnvironmentId === environment.id) {
        throw new Error(
          'This server is the default host for new projects. Choose another one under New projects open on before removing it.'
        )
      }
      // A closed gate leaves persisted WSL hosts untouched on disk.
      assertWslHostReachable(environment)
      const ownedRemoval = removeThroughOwningService(environment)
      if (ownedRemoval) {
        // A WSL host whose server Remove couldn't prove stopped stays listed; say so (E11).
        return ownedRemoval.then((serverStop) => ({
          removed: redactRuntimeEnvironment(environment),
          serverStop
        }))
      }
      const redundantManagedRemoval = removeRedundantManagedPairing(getUserDataPath(), environment)
      if (redundantManagedRemoval) {
        return redundantManagedRemoval.then((removal) => {
          closeLegacySelectorTransport(args.selector, environment.id)
          return removal
        })
      }
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      void retireRemovedRuntimeEnvironment(
        removed.id,
        invalidateTransport,
        store,
        getUserDataPath()
      )
      closeLegacySelectorTransport(args.selector, removed.id)
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    async (
      _event,
      args: { selector: string }
    ): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      const runtimeLayer = { userDataPath: getUserDataPath(), invalidateTransport }
      disconnectRuntimeEnvironmentForUser(environment.id, runtimeLayer)
      closeLegacySelectorTransport(args.selector, environment.id)
      // Also clear the managed host SSH connection shown in Settings (#30085).
      await disconnectManagedHostOfEnvironmentForUser(environment, runtimeLayer)
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:connect',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      assertWslHostReachable(environment)
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      noteRuntimeEnvironmentConnectRequested(environment.id)
      clearSshCredentialDeclinedForEnvironment(environment)
      await liftSshUserDisconnectForEnvironment(environment)
      await connectThroughOwningService(environment)
      return getRuntimeEnvironmentStatus(getUserDataPath(), environment.id, args.timeoutMs, {
        reconnect: true
      })
    }
  )
}

export function registerRuntimeEnvironmentPassiveHandlers(
  getUserDataPath: () => string,
  recordAnswer?: RecordRuntimeEnvironmentAnswer
): void {
  registerPassiveStatusHandler(getUserDataPath)
  registerPassiveCallHandler(getUserDataPath, recordAnswer)
}

function closeLegacySelectorTransport(selector: string, environmentId: string): void {
  if (selector === environmentId) {
    return
  }
  closeRemoteRuntimeRequestConnection(selector)
}

function registerPassiveStatusHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number; observeOnly?: true }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs,
        args.observeOnly ? { observeOnly: true } : undefined
      )
      observeWslOrcadHostResponse(environment.id, 'status.get', response)
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}

type RecordRuntimeEnvironmentAnswer = (
  environment: ReturnType<typeof resolveEnvironment>,
  method: string,
  response: RuntimeRpcResponse<unknown>
) => void

function registerPassiveCallHandler(
  getUserDataPath: () => string,
  recordAnswer?: RecordRuntimeEnvironmentAnswer
): void {
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
        expectedEnvironmentRuntimeId?: string
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      if (isHostSpawnFencedForWslMoveUndo(environment.id, args.method)) {
        return wslMoveUndoSpawnFencedResponse(environment, args.method)
      }
      void desktopChatCreationHistory(getUserDataPath()).recordCreate(
        environment.id,
        args.method,
        args.params
      )
      // Every renderer request to a paired host passes this account environment boundary.
      const accounts = await withWslOrcadAccountEnv({
        environmentId: environment.id,
        method: args.method,
        params: args.params,
        hostSupports: (capability) =>
          wslOrcadHostSupports(environment.id, capability, () =>
            callRuntimeEnvironment(getUserDataPath(), environment.id, 'status.get', undefined)
          )
      })
      if (!accounts.ok) {
        return {
          id: args.method,
          ok: false,
          error: { code: 'account_preparation_failed', message: accounts.message },
          _meta: { runtimeId: environment.runtimeId }
        }
      }
      let response: RuntimeRpcResponse<unknown>
      try {
        response = await callRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          accounts.params,
          args.timeoutMs,
          args.expectedEnvironmentPairingRevision,
          undefined,
          { expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId }
        )
      } catch (error) {
        const failure = runtimeEnvironmentCallFailure(environment, args.method, error)
        if (failure) {
          return failure
        }
        throw error
      }
      observeWslOrcadHostResponse(environment.id, args.method, response)
      recordAnswer?.(environment, args.method, response)
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}
