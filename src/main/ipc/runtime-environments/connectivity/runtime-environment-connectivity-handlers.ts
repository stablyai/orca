import {
  manuallyDisconnectedResponse,
  runtimeEnvironmentCallFailure
} from '../requests/runtime-environment-call-failure'
import { desktopChatCreationHistory } from '../../../runtime/client/navigation/desktop-chat-creation-history'
import { ipcMain } from 'electron'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { connectThroughOwningService } from './runtime-environment-host-service-ops'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { readSettingsWithRuntimeEnvironmentPreference } from '../catalog/runtime-environment-preference'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from '../pairing/runtime-environment-pairing-verification'
import { publishVerifiedPairing } from '../pairing/runtime-environment-verified-pairing-publish'
import { getRuntimeEnvironmentStatusSnapshots } from '../connections/runtime-environment-request-connections'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import {
  closeLegacySelectorTransport,
  registerRuntimeEnvironmentRemoveHandler,
  type ConnectivityHandlerOptions
} from './runtime-environment-remove-handler'
import { callRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'
import { rendererOrchestrationEnvelope } from '../connections/runtime-environment-shared-control-envelope'
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
  ipcMain.handle('runtimeEnvironments:list', async () => {
    const environments = (await listEnvironments(getUserDataPath())).filter(
      (environment) => !isGatedOffWslHost(environment)
    )
    await readSettingsWithRuntimeEnvironmentPreference(store, getUserDataPath())
    return environments.map(publicRuntimeEnvironmentWithHostKey)
  })
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    async (
      _event,
      args: { name: string; pairingCode: string }
    ): Promise<{ environment: PublicKnownRuntimeEnvironment }> => {
      // An unverified code must not replace a working pairing.
      const environment = await addEnvironmentFromPairingCode(getUserDataPath(), args)
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
  ipcMain.handle('runtimeEnvironments:resolve', async (_event, args: { selector: string }) =>
    redactRuntimeEnvironment(await resolveEnvironment(getUserDataPath(), args.selector))
  )
  registerRuntimeEnvironmentRemoveHandler({ store, getUserDataPath, invalidateTransport })
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    async (
      _event,
      args: { selector: string }
    ): Promise<{ disconnected: PublicKnownRuntimeEnvironment }> => {
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
      const runtimeLayer = { userDataPath: getUserDataPath(), invalidateTransport }
      await disconnectRuntimeEnvironmentForUser(environment.id, runtimeLayer)
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
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
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

function registerPassiveStatusHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number; observeOnly?: true; force?: true }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs,
        { observeOnly: args.observeOnly, force: args.force }
      )
      observeWslOrcadHostResponse(environment.id, 'status.get', response)
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedResponse(environment)
        : response
    }
  )
}

type RecordRuntimeEnvironmentAnswer = (
  environment: Awaited<ReturnType<typeof resolveEnvironment>>,
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
        background?: boolean
        wake?: boolean
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
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
            callRuntimeEnvironment(
              getUserDataPath(),
              environment.id,
              'status.get',
              undefined,
              undefined,
              undefined,
              undefined,
              { wake: args.wake === true }
            )
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
          rendererOrchestrationEnvelope(args.method, accounts.params),
          {
            expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
            background: args.background === true,
            wake: args.wake === true
          }
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
