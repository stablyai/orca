import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../shared/pty-ownership-transfer-runtime-methods'
import { subscribeRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'

type CallRuntimeEnvironment = (
  userDataPath: string,
  selector: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  envelope?: RuntimeOrchestrationEnvelope,
  options?: { signal?: AbortSignal }
) => Promise<RuntimeRpcResponse<unknown>>

type ResolveEnvironment = (userDataPath: string, selector: string) => { runtimeId: string | null }

export type CallPairedRuntimePtyOwnershipTransferRpc = (
  environmentId: string,
  method: string,
  params: unknown,
  requestOptions?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<unknown>

export type SubscribePairedRuntimePtyOwnershipTransfer = (
  environmentId: string,
  method: string,
  params: unknown,
  callbacks: {
    onEvent: (result: unknown) => void
    onError: (error: { code: string; message: string }) => void
    onClose: () => void
  }
) => Promise<{
  close: () => void
  sendRequest?: (
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
}>

/** Creates the read-only paired-runtime RPC bridge with replacement fencing. */
export function createPairedRuntimePtyOwnershipTransferRpc(options: {
  userDataPath: string
  callRuntimeEnvironment: CallRuntimeEnvironment
  resolveEnvironment: ResolveEnvironment
  getTransportGeneration: (environmentId: string) => number
}): CallPairedRuntimePtyOwnershipTransferRpc {
  return async function callPairedRuntimePtyOwnershipTransferRpc(
    environmentId: string,
    method: string,
    params: unknown,
    requestOptions?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<unknown> {
    if (!isPairedRuntimeOwnershipTransferMethod(method)) {
      throw new Error('pty_ownership_transfer_paired_method_unsupported')
    }
    const before = options.resolveEnvironment(options.userDataPath, environmentId)
    const beforeTransportGeneration = options.getTransportGeneration(environmentId)
    const response = await options.callRuntimeEnvironment(
      options.userDataPath,
      environmentId,
      pairedRuntimeSourceMethod(method),
      params,
      requestOptions?.timeoutMs,
      undefined,
      undefined,
      { signal: requestOptions?.signal }
    )
    const after = options.resolveEnvironment(options.userDataPath, environmentId)
    const afterTransportGeneration = options.getTransportGeneration(environmentId)
    // A paired runtime may be replaced while an RPC is in flight. Its response must never
    // be applied to a new owner, even when the JSON payload itself is well-formed.
    if (
      !before.runtimeId ||
      !after.runtimeId ||
      response._meta?.runtimeId !== after.runtimeId ||
      before.runtimeId !== after.runtimeId ||
      beforeTransportGeneration !== afterTransportGeneration
    ) {
      throw new Error('pty_ownership_transfer_paired_runtime_replaced')
    }
    if (!response.ok) {
      const error = new Error(response.error.message) as Error & { code?: string }
      error.code = response.error.code
      throw error
    }
    return response.result
  }
}

/** Creates the authenticated source-runtime event stream bridge. */
export function createPairedRuntimePtyOwnershipTransferSubscription(options: {
  userDataPath: string
  subscribeRuntimeEnvironment?: typeof subscribeRuntimeEnvironment
  resolveEnvironment: ResolveEnvironment
  getTransportGeneration: (environmentId: string) => number
}): SubscribePairedRuntimePtyOwnershipTransfer {
  const subscribe = options.subscribeRuntimeEnvironment ?? subscribeRuntimeEnvironment
  return async (environmentId, method, params, callbacks) => {
    if (method !== PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.streamSource) {
      throw new Error('pty_ownership_transfer_paired_method_unsupported')
    }
    const before = options.resolveEnvironment(options.userDataPath, environmentId)
    const beforeTransportGeneration = options.getTransportGeneration(environmentId)
    if (!before.runtimeId) {
      throw new Error('pty_ownership_transfer_paired_runtime_replaced')
    }
    let closed = false
    let activeSubscription: RemoteRuntimeSubscription | null = null
    let replacementReported = false
    const reportReplacement = (): void => {
      if (replacementReported) {
        return
      }
      replacementReported = true
      callbacks.onError({
        code: 'pty_ownership_transfer_paired_runtime_replaced',
        message: 'Paired runtime transport was replaced while ownership output was streaming.'
      })
      activeSubscription?.close()
    }
    const subscription: RemoteRuntimeSubscription = await subscribe(
      options.userDataPath,
      environmentId,
      method,
      params,
      undefined,
      {
        onEvent: (event) => {
          if (closed) {
            return
          }
          const after = options.resolveEnvironment(options.userDataPath, environmentId)
          if (
            !after.runtimeId ||
            after.runtimeId !== before.runtimeId ||
            options.getTransportGeneration(environmentId) !== beforeTransportGeneration
          ) {
            reportReplacement()
            return
          }
          if (event.type === 'error') {
            callbacks.onError({ code: event.code, message: event.message })
            return
          }
          if (event.type === 'close' || event.type === 'binary') {
            return
          }
          if (event.type === 'response') {
            const response = event.response
            if (!response.ok) {
              callbacks.onError({ code: response.error.code, message: response.error.message })
              return
            }
            if (response._meta.runtimeId !== before.runtimeId) {
              reportReplacement()
              return
            }
            callbacks.onEvent(response.result)
          }
        },
        onClose: callbacks.onClose
      }
    )
    activeSubscription = subscription
    if (replacementReported) {
      subscription.close()
      throw new Error('pty_ownership_transfer_paired_runtime_replaced')
    }
    const afterSubscribe = options.resolveEnvironment(options.userDataPath, environmentId)
    if (
      !afterSubscribe.runtimeId ||
      afterSubscribe.runtimeId !== before.runtimeId ||
      options.getTransportGeneration(environmentId) !== beforeTransportGeneration
    ) {
      reportReplacement()
      throw new Error('pty_ownership_transfer_paired_runtime_replaced')
    }
    return {
      close: () => {
        closed = true
        subscription.close()
      },
      ...(subscription.sendRequest ? { sendRequest: subscription.sendRequest } : {})
    }
  }
}

function isPairedRuntimeOwnershipTransferMethod(method: string): boolean {
  return [
    ...Object.values(PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS),
    'pty.ownershipTransfer.prepare',
    'pty.ownershipTransfer.replay',
    'pty.ownershipTransfer.commit',
    'pty.ownershipTransfer.publish',
    'pty.ownershipTransfer.input',
    'pty.ownershipTransfer.retireInput',
    'pty.ownershipTransfer.attach',
    'pty.ownershipTransfer.rekeyReconnect',
    'pty.ownershipTransfer.control',
    'pty.ownershipTransfer.abort',
    'pty.ownershipTransfer.acknowledgeOutput',
    'pty.ownershipTransfer.status'
  ].includes(
    method as (typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS]
  )
}

function pairedRuntimeSourceMethod(method: string): string {
  const suffixByMethod: Record<string, string> = {
    'pty.ownershipTransfer.prepare': 'prepareSource',
    'pty.ownershipTransfer.replay': 'replaySource',
    'pty.ownershipTransfer.commit': 'commitSource',
    'pty.ownershipTransfer.publish': 'publishSource',
    'pty.ownershipTransfer.input': 'inputSource',
    'pty.ownershipTransfer.retireInput': 'retireInputSource',
    'pty.ownershipTransfer.attach': 'attachSource',
    'pty.ownershipTransfer.rekeyReconnect': 'rekeyReconnectSource',
    'pty.ownershipTransfer.control': 'controlSource',
    'pty.ownershipTransfer.abort': 'abortSource',
    'pty.ownershipTransfer.acknowledgeOutput': 'acknowledgeOutputSource',
    'pty.ownershipTransfer.status': 'statusSource'
  }
  const suffix = suffixByMethod[method]
  return suffix ? `pty.ownershipTransfer.${suffix}` : method
}
