import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import { isRegistrationFencedUnsubscribe, type RpcContext, type RpcRequest } from './core'
import { resolveRpcCallerIdentity } from './rpc-caller-identity'
import type { RpcCallerScope } from './rpc-caller-scope'

export type RpcDispatchStreamingOptions = Pick<
  RpcContext,
  | 'authenticatedCallerFingerprint'
  | 'connectionId'
  | 'signal'
  | 'clientId'
  | 'pairedDeviceId'
  | 'caller'
  | 'clientKind'
  | 'clientCapabilities'
  | 'updateClientCapabilities'
  | 'pairing'
  | 'sendBinary'
  | 'registerBinaryStreamHandler'
  | 'registerBinaryMessageHandler'
> & {
  /** What the transport proved the caller may do; absent means this host's owner. */
  callerScope?: RpcCallerScope
}

export function rpcContextFromTransport(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  options: RpcDispatchStreamingOptions | undefined,
  orchestrationCaller: OrchestrationSessionCaller | undefined
): RpcContext {
  return {
    runtime,
    signal: options?.signal,
    requestId: request.id,
    connectionId: options?.connectionId,
    // Session tabs always need this fence. COMPAT(terminal request-addressed unsubscribe): terminal only for phones without `requestId`.
    // Capture before middleware yields to a replacement subscribe on the same connection.
    subscriptionRegistrationVersion: isRegistrationFencedUnsubscribe(request.method)
      ? runtime.getSubscriptionRegistrationVersion()
      : undefined,
    clientId: options?.clientId,
    pairedDeviceId: options?.pairedDeviceId,
    caller: resolveRpcCallerIdentity(options),
    clientKind: options?.clientKind,
    clientCapabilities: options?.clientCapabilities,
    updateClientCapabilities: options?.updateClientCapabilities,
    authenticatedCallerFingerprint: options?.authenticatedCallerFingerprint,
    pairing: options?.pairing,
    sendBinary: options?.sendBinary,
    registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
    registerBinaryMessageHandler: options?.registerBinaryMessageHandler,
    orchestrationCaller
  }
}
