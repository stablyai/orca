import { mainProcessState } from '../../startup/main-process-state'
import { ipcMain } from 'electron'
import {
  assertTerminalChatCallCurrent,
  withTerminalChatCallDeadline
} from './terminal-chat-call-deadline'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import {
  manuallyDisconnectedResponse,
  runtimeEnvironmentCallFailure
} from './requests/runtime-environment-call-failure'
import { desktopChatCreationHistory } from '../../runtime/client/navigation/desktop-chat-creation-history'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeEnvironmentManuallyDisconnected } from './connectivity/runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'
import { withWslOrcadAccountEnv } from '../../wsl/orcad/wsl-orcad-account-env'
import {
  observeWslOrcadHostResponse,
  wslOrcadHostSupports
} from '../../wsl/orcad/wsl-orcad-host-environments'
import {
  isHostSpawnFencedForWslMoveUndo,
  wslMoveUndoSpawnFencedResponse
} from '../../persistence/moving-wsl-projects/cutover-recovery/wsl-move-undo-spawn-fence'

export type RecordRuntimeEnvironmentAnswer = (
  environment: ReturnType<typeof resolveEnvironment>,
  method: string,
  response: RuntimeRpcResponse<unknown>
) => void

export function registerPassiveCallHandler(
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
      return withTerminalChatCallDeadline(
        args,
        async (signal, chatPromptBudget) => {
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
          assertTerminalChatCallCurrent(chatPromptBudget)
          throwIfSignalAborted(signal)
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
              {
                expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
                signal,
                chatPromptBudget
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
        },
        mainProcessState.runtime?.getRuntimeId()
      )
    }
  )
}
