import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationMigrationData } from '../../../../shared/orchestration/orchestration-rpc-contract'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  OrchestrationEnvironmentCallOptions,
  OrchestrationEnvironmentTransport
} from './environment-transport'
import { OrchestrationError } from '../orchestration-error'
import { UnsentRequestError } from './unsent-request-error'

type PinnedSend = (expectedRuntimeId: string) => Promise<RuntimeRpcResponse<unknown>>

/** Pins a call strictly to the caller's verified runtime instance; never retries onto another instance. */
export async function sendOnPinnedRuntime(args: {
  contractVerifiedRuntimeIds: Map<string, string>
  transport: OrchestrationEnvironmentTransport
  selector: string
  expectedRuntimeId: string
  verifyContract: boolean
  send: PinnedSend
  timeoutMs: number | undefined
  internal: OrchestrationEnvironmentCallOptions | undefined
}): Promise<RuntimeRpcResponse<unknown>> {
  const {
    contractVerifiedRuntimeIds,
    transport,
    selector,
    expectedRuntimeId,
    verifyContract,
    send,
    timeoutMs,
    internal
  } = args
  if (verifyContract && contractVerifiedRuntimeIds.get(selector) !== expectedRuntimeId) {
    const verifiedRuntimeId = await verifyWorkerServerContract(
      contractVerifiedRuntimeIds,
      transport,
      selector,
      timeoutMs,
      internal
    )
    if (verifiedRuntimeId !== expectedRuntimeId) {
      throw new UnsentRequestError(
        'runtime_environment_changed',
        'Runtime environment identity changed; refresh and try again',
        { effectsApplied: false }
      )
    }
  }
  const response = await send(expectedRuntimeId)
  if (response.ok === false && response.error.code === 'runtime_environment_changed') {
    if (contractVerifiedRuntimeIds.get(selector) === expectedRuntimeId) {
      contractVerifiedRuntimeIds.delete(selector)
    }
    const data =
      response.error.data && typeof response.error.data === 'object'
        ? { ...response.error.data, effectsApplied: false }
        : { effectsApplied: false }
    throw new UnsentRequestError(response.error.code, response.error.message, data)
  }
  return response
}

/** Pins a mutation to the incarnation that proved the contract, so a restarted host refuses it before any effect. */
export async function sendOnContractVerifiedRuntime(args: {
  contractVerifiedRuntimeIds: Map<string, string>
  transport: OrchestrationEnvironmentTransport
  selector: string
  send: PinnedSend
  timeoutMs: number | undefined
  internal: OrchestrationEnvironmentCallOptions | undefined
}): Promise<RuntimeRpcResponse<unknown>> {
  const { contractVerifiedRuntimeIds, transport, selector, send, timeoutMs, internal } = args
  const verifiedRuntimeId = contractVerifiedRuntimeIds.get(selector)
  if (verifiedRuntimeId) {
    const response = await send(verifiedRuntimeId)
    if (response.ok || response.error.code !== 'runtime_environment_changed') {
      return response
    }
    contractVerifiedRuntimeIds.delete(selector)
  }
  return send(
    await verifyWorkerServerContract(
      contractVerifiedRuntimeIds,
      transport,
      selector,
      timeoutMs,
      internal
    )
  )
}

/** Proves the current orchestration contract and returns the incarnation that proved it. */
async function verifyWorkerServerContract(
  contractVerifiedRuntimeIds: Map<string, string>,
  transport: OrchestrationEnvironmentTransport,
  selector: string,
  timeoutMs: number | undefined,
  internal: OrchestrationEnvironmentCallOptions | undefined
): Promise<string> {
  const statusResponse = await transport.call(
    selector,
    'status.get',
    undefined,
    timeoutMs,
    undefined,
    internal?.expectedEnvironmentPairingRevision
  )
  if (statusResponse.ok === false) {
    throw new UnsentRequestError(
      statusResponse.error.code,
      statusResponse.error.message,
      statusResponse.error.data
    )
  }
  const status = statusResponse.result as RuntimeStatus
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      'The connected worker server does not support the current orchestration contract. No effects were applied.',
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  contractVerifiedRuntimeIds.set(selector, statusResponse._meta.runtimeId)
  return statusResponse._meta.runtimeId
}
