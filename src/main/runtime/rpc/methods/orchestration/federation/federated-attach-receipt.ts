import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import type { AgentLaunchModeReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'

export type RemoteFederatedWorkerStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch?: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  /** Chat or terminal, as the server decided; absent from servers that start terminals only. */
  mode?: AgentLaunchModeReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

export type ReadyRemoteFederatedWorkerStartReceipt = RemoteFederatedWorkerStartReceipt & {
  state: 'ready'
  runtimeEpoch: string
  worktreeId: string
  terminalHandle: string
}

export function parseRemoteFederatedWorkerStartReceipt(
  value: unknown
): RemoteFederatedWorkerStartReceipt {
  if (!isRecord(value) || !isNonEmptyString(value.dispatchId) || !isNonEmptyString(value.state)) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  if (
    value.state === 'ready' &&
    (!isNonEmptyString(value.runtimeEpoch) ||
      !isNonEmptyString(value.worktreeId) ||
      !isNonEmptyString(value.terminalHandle))
  ) {
    throw new Error('The worker server returned an invalid ready receipt.')
  }
  return value as RemoteFederatedWorkerStartReceipt
}

export function isReadyRemoteFederatedWorkerStartReceipt(
  receipt: RemoteFederatedWorkerStartReceipt
): receipt is ReadyRemoteFederatedWorkerStartReceipt {
  return receipt.state === 'ready'
}

/** The ready receipt's parts the server reports as is. */
export function readyRemoteReceiptFields(remote: ReadyRemoteFederatedWorkerStartReceipt) {
  return {
    setup: remote.setup,
    ...(remote.mode ? { mode: remote.mode } : {}),
    effects: remote.effects ?? [],
    residualResources: remote.residualResources ?? []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
