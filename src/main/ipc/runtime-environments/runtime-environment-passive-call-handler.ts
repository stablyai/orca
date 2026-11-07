import { ipcMain } from 'electron'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeEnvironmentCallResult,
  RuntimeEnvironmentSelectedPairing
} from '../../../shared/runtime-environment-selected-pairing'
import { desktopChatCreationHistory } from '../../runtime/desktop-chat-creation-history'
import { withWslOrcadAccountEnv } from '../../wsl/orcad/wsl-orcad-account-env'
import {
  observeWslOrcadHostResponse,
  wslOrcadHostSupports
} from '../../wsl/orcad/wsl-orcad-host-environments'
import {
  isHostSpawnFencedForWslMoveUndo,
  wslMoveUndoSpawnFencedResponse
} from '../../persistence/moving-wsl-projects/wsl-move-undo-spawn-fence'
import type { RemoteGeneratedInputIngress } from '../runtime'
import {
  manuallyDisconnectedResponse,
  runtimeEnvironmentCallFailure
} from './runtime-environment-call-failure'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { generatedInputDispatch } from './runtime-environment-generated-input-dispatch'
import { remoteRuntimeRequestDispatchExpiredError } from '../../../shared/remote-runtime/requests/remote-runtime-request-dispatch-observation'

export type RecordRuntimeEnvironmentAnswer = (
  environment: ReturnType<typeof resolveEnvironment>,
  method: string,
  response: RuntimeRpcResponse<unknown>
) => void

export function registerPassiveCallHandler(
  getUserDataPath: () => string,
  recordAnswer?: RecordRuntimeEnvironmentAnswer,
  acceptGeneratedInput?: RemoteGeneratedInputIngress
): void {
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
        expectedEnvironmentRuntimeId?: string
        generatedInputOperationId?: string
        /** Local only: the end its renderer accepted a generated request with. */
        generatedInputEnd?: number
      }
    ): Promise<RuntimeEnvironmentCallResult> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      // Before any refusal or wait: a generated request's text is held by this window's runtime,
      // and a refusal here proves it was never sent.
      const generated = acceptGeneratedInput?.(event, environment, args)
      const observeGeneratedInput = generated?.observer
      // The pairing this window's request was first resolved to holds for every call of it.
      const expectedEnvironmentPairingRevision =
        generated?.pairingRevision ?? args.expectedEnvironmentPairingRevision
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        observeGeneratedInput?.answered(null)
        return manuallyDisconnectedResponse(environment)
      }
      if (isHostSpawnFencedForWslMoveUndo(environment.id, args.method)) {
        observeGeneratedInput?.answered(null)
        return wslMoveUndoSpawnFencedResponse(environment, args.method)
      }
      // From here to its frame's handoff, every wait of a generated request spends its own end.
      const dispatch = generatedInputDispatch(args.method, args.params, args.generatedInputEnd)
      try {
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
          observeGeneratedInput?.answered(null)
          return {
            id: args.method,
            ok: false,
            error: { code: 'account_preparation_failed', message: accounts.message },
            _meta: { runtimeId: environment.runtimeId }
          }
        }
        if (dispatch?.expired()) {
          observeGeneratedInput?.answered(null)
          return runtimeEnvironmentCallFailure(
            environment,
            args.method,
            remoteRuntimeRequestDispatchExpiredError()
          )!
        }
        let response: RuntimeRpcResponse<unknown>
        let selectedPairing: RuntimeEnvironmentSelectedPairing | undefined
        try {
          response = await callRuntimeEnvironment(
            getUserDataPath(),
            environment.id,
            args.method,
            accounts.params,
            args.timeoutMs,
            expectedEnvironmentPairingRevision,
            undefined,
            {
              expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
              ...(dispatch ? { signal: dispatch.signal } : {}),
              // Beside a status answer: the pairing main itself selected for it.
              ...(args.method === 'status.get'
                ? { observeStatusSelection: (selected) => (selectedPairing = selected) }
                : {})
            }
          )
        } catch (error) {
          observeGeneratedInput?.answered(null)
          const failure = runtimeEnvironmentCallFailure(environment, args.method, error)
          if (failure) {
            return failure
          }
          throw error
        }
        observeGeneratedInput?.answered(response)
        observeWslOrcadHostResponse(environment.id, args.method, response)
        recordAnswer?.(environment, args.method, response)
        if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
          return manuallyDisconnectedResponse(environment)
        }
        return selectedPairing ? { ...response, selectedPairing } : response
      } finally {
        dispatch?.dispose()
      }
    }
  )
}
