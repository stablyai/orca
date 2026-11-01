import { randomUUID } from 'node:crypto'
import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import {
  isDurableMutation,
  isOrchestrationMutation,
  isTerminalPromptMutation,
  orchestrationMigrationData
} from '../../shared/orchestration-rpc-contract'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { openLocalOrca } from './open-local-orca'
import { getDefaultUserDataPath, readMetadata } from './metadata'
import {
  getCliStatus,
  getOfflineRuntimeAdmission,
  type OfflineRuntimeAdmission,
  projectRemoteAppStatus
} from './status'
import { sendRequest } from './transport'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess,
  type RuntimeCallOptions
} from './types'
import {
  attachDurableMutationRecovery,
  attachLegacyTerminalPromptRecovery,
  attachUnverifiedTerminalPromptRecovery,
  didAnotherRuntimeHandleTerminalPrompt
} from './terminal-prompt-mutation-recovery'
import { markEnvironmentUsed } from './environments'
import { createRuntimeSourceFence, type RuntimeSourceFence } from './runtime-source-fence'
import { resolveRemoteConnection } from './runtime-remote-pairing'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../shared/protocol-version'
import { RemoteRuntimeCompatGate } from './remote-runtime-compat-gate'
import { createOrchestrationCompatibilityEnvelope } from './orchestration-compatibility-envelope'
import { getTimeoutMsParam, isWaitingCheck } from './runtime-request-timeout'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartClientTimeoutMs,
  resolveWorkerStartReadinessTimeoutMs
} from '../../shared/orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  buildOrchestrationRecoveryCommand,
  resolveOrchestrationCliExecutable
} from './orchestration-recovery-command'

const LONG_POLL_CLIENT_GRACE_MS = 10_000

const loadWebSocketTransport = async () => await import('./websocket-transport.js')

export class RuntimeClient {
  readonly userDataPath: string
  private readonly remote: PairedRuntimeConnection | null
  readonly environmentSelector: string | null
  private readonly cliExecutable: string
  private readonly originalArgs: readonly string[] | undefined
  private readonly remoteCompat: RemoteRuntimeCompatGate
  private orchestrationContractCheck: Promise<void> | null = null
  private readonly orchestrationCompatibility = createOrchestrationCompatibilityEnvelope(
    process.env
  )
  private readonly runtimeSourceFence: RuntimeSourceFence

  // Browser session cold starts can take 15–30 seconds; allow time for initialization.
  constructor(
    userDataPath = getDefaultUserDataPath(),
    private readonly requestTimeoutMs = 60_000,
    remotePairingCode = process.env.ORCA_PAIRING_CODE ?? process.env.ORCA_REMOTE_PAIRING ?? null,
    environmentSelector = process.env.ORCA_ENVIRONMENT ?? null,
    cliExecutable = resolveOrchestrationCliExecutable(),
    originalArgs?: readonly string[]
  ) {
    this.userDataPath = userDataPath
    this.environmentSelector = environmentSelector
    this.cliExecutable = cliExecutable
    this.originalArgs = originalArgs ? [...originalArgs] : undefined
    this.remote = resolveRemoteConnection(userDataPath, remotePairingCode, environmentSelector)
    this.remoteCompat = new RemoteRuntimeCompatGate(userDataPath, environmentSelector)
    this.runtimeSourceFence = createRuntimeSourceFence(process.env, userDataPath, requestTimeoutMs)
  }

  get isRemote(): boolean {
    return this.remote !== null
  }

  async call<TResult>(
    method: string,
    params?: unknown,
    options?: RuntimeCallOptions
  ): Promise<RuntimeRpcSuccess<TResult>> {
    const effectiveTimeoutMs = options?.timeoutMs ?? this.resolveMethodTimeoutMs(method, params)
    const orchestrationMutation = isOrchestrationMutation(method, params)
    const terminalPromptMutation = isTerminalPromptMutation(method, params)
    const legacyTerminalPrompt = options?.legacyTerminalPrompt === true && terminalPromptMutation
    const durableMutation = !legacyTerminalPrompt && isDurableMutation(method, params)
    if (orchestrationMutation) {
      await this.ensureOrchestrationContractCompatible(effectiveTimeoutMs)
    }
    const orchestrationRequestId = durableMutation
      ? (options?.orchestrationRequestId ?? randomUUID())
      : undefined
    const originalCommand = durableMutation
      ? buildOrchestrationRecoveryCommand(method, params, this.cliExecutable, this.originalArgs)
      : undefined
    const recover = (error: unknown, targetRuntimeId: string | null) => {
      if (legacyTerminalPrompt) {
        return attachLegacyTerminalPromptRecovery(error)
      }
      if (
        terminalPromptMutation &&
        options?.terminalPromptPreflight &&
        didAnotherRuntimeHandleTerminalPrompt(
          error,
          options.terminalPromptPreflight.runtimeId,
          targetRuntimeId
        )
      ) {
        return attachUnverifiedTerminalPromptRecovery(error)
      }
      return attachDurableMutationRecovery(error, orchestrationRequestId, originalCommand, method)
    }
    const compatibilityEnvelope = method.startsWith('orchestration.')
      ? {
          ...this.orchestrationCompatibility,
          compatibilityInvocationId:
            orchestrationRequestId ?? this.orchestrationCompatibility.compatibilityInvocationId
        }
      : {}
    const envelope = {
      orchestrationCapability: options?.orchestrationCapability,
      orchestrationContractVersion: method.startsWith('orchestration.')
        ? ORCHESTRATION_CONTRACT_VERSION
        : undefined,
      orchestrationRequestId,
      ...compatibilityEnvelope
    }
    if (this.remote) {
      const transport = await loadWebSocketTransport()
      let response
      try {
        response = await this.remoteCompat.send<TResult>({
          transport,
          connection: this.remote,
          method,
          params,
          timeoutMs: effectiveTimeoutMs,
          envelope,
          requestSelection: options?.requestSelection
        })
      } catch (error) {
        throw recover(error, null)
      }
      if (response.ok === false) {
        throw recover(new RuntimeRpcFailureError(response), null)
      }
      if (this.environmentSelector) {
        markEnvironmentUsed(this.userDataPath, this.environmentSelector, {
          runtimeId: response._meta.runtimeId
        })
      }
      return response
    }
    const metadata = readMetadata(this.userDataPath)
    // Refusal precedes sending, so there is no request to recover.
    const expectedRuntimeSource = await this.runtimeSourceFence.check(metadata, method)
    let response
    try {
      response = await sendRequest<TResult>(
        metadata,
        method,
        params,
        effectiveTimeoutMs,
        envelope,
        expectedRuntimeSource,
        options?.requestSelection ? { requestSelection: options.requestSelection } : undefined
      )
    } catch (error) {
      throw recover(error, metadata.runtimeId ?? null)
    }
    if (response.ok === false) {
      throw recover(new RuntimeRpcFailureError(response), metadata.runtimeId ?? null)
    }
    return response
  }

  // Give server-side waits time to finish before the client transport times out.
  private resolveMethodTimeoutMs(method: string, params?: unknown): number {
    if (method === 'orchestration.workerStart') {
      const requestedValue = getTimeoutMsParam(params)
      const requested = typeof requestedValue === 'number' ? requestedValue : Number(requestedValue)
      if (!isWorkerStartTimeoutWithinTimerLimit(requested)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `--timeout-ms is too large for worker-start transport grace; the derived timeout must be <= ${MAX_TIMER_DELAY_MS}ms.`
        )
      }
      const readiness = resolveWorkerStartReadinessTimeoutMs(requested)
      return Math.max(resolveWorkerStartClientTimeoutMs(readiness), this.requestTimeoutMs)
    }
    // A send to a finished worker starts its follow-up, which waits as worker-start does.
    if (method === 'orchestration.send') {
      return Math.max(resolveWorkerStartClientTimeoutMs(), this.requestTimeoutMs)
    }
    if (
      (method === 'orchestration.check' && isWaitingCheck(params)) ||
      method === 'terminal.wait'
    ) {
      const inner = Number(getTimeoutMsParam(params))
      if (Number.isFinite(inner) && inner > 0) {
        return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, this.requestTimeoutMs)
      }
    }
    return this.requestTimeoutMs
  }

  async getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    if (this.remote) {
      const response = await this.call<RuntimeStatus>('status.get')
      this.remoteCompat.noteVerifiedStatus(response.result)
      const graphState = response.result.graphStatus
      return {
        id: response.id,
        ok: true,
        result: {
          target: {
            kind: 'environment',
            environment: this.environmentSelector ?? 'pairing-code'
          },
          app: projectRemoteAppStatus(response.result),
          runtime: {
            state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
            reachable: true,
            connectionState: runtimeHostConnectionState({
              hasStatusEntry: true,
              status: response.result
            }),
            runtimeId: response.result.runtimeId,
            ...(response.result.appVersion ? { appVersion: response.result.appVersion } : {}),
            ...(response.result.remoteUpdateSupport
              ? { remoteUpdateSupport: response.result.remoteUpdateSupport }
              : {}),
            ...(response.result.capabilities ? { capabilities: response.result.capabilities } : {}),
            ...(response.result.degradations ? { degradations: response.result.degradations } : {})
          },
          graph: {
            state: graphState
          }
        },
        _meta: response._meta
      }
    }
    return getCliStatus(this.userDataPath)
  }

  async getOfflineRuntimeAdmission(): Promise<OfflineRuntimeAdmission> {
    if (this.remote) {
      const status = await this.getCliStatus()
      return {
        reachable: status.result.runtime.reachable,
        legacyPidRunning: status.result.app.running,
        pid: status.result.app.pid ?? null
      }
    }
    return getOfflineRuntimeAdmission(this.userDataPath)
  }

  private async ensureOrchestrationContractCompatible(timeoutMs: number): Promise<void> {
    if (!this.orchestrationContractCheck) {
      this.orchestrationContractCheck = this.checkOrchestrationContractCompatibility(
        timeoutMs
      ).catch((error: unknown) => {
        // Failed probes must be retried after transient outages.
        this.orchestrationContractCheck = null
        throw error
      })
    }
    await this.orchestrationContractCheck
  }

  private async checkOrchestrationContractCompatibility(timeoutMs: number): Promise<void> {
    const response = await this.call<RuntimeStatus>('status.get', undefined, { timeoutMs })
    if (this.remote) {
      this.remoteCompat.noteVerifiedStatus(response.result)
    }
    if (!response.result.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'orchestration_migration_required',
        'The connected Orca runtime does not support the current orchestration contract. No effects were applied.',
        orchestrationMigrationData('runtime_capability_missing')
      )
    }
  }

  async openOrca(timeoutMs = 15_000): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    return this.remote ? this.getCliStatus() : openLocalOrca(() => this.getCliStatus(), timeoutMs)
  }
}
