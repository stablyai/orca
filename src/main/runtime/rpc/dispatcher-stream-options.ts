import type { OrcaRuntimeService } from '../orca-runtime'
import { captureStructuredAgentCliSource } from '../../native-chat/structured-agent-cli-source'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import { isRegistrationFencedUnsubscribe, type RpcContext, type RpcRequest } from './core'
import { resolveRpcCallerIdentity } from './rpc-caller-identity'
import type { RpcCallerScope } from './rpc-caller-scope'

export type RpcDispatchStreamingOptions = Pick<
  RpcContext,
  | 'authenticatedCallerFingerprint'
  | 'connectionId'
  | 'signal'
  | 'retainConnectionLifetime'
  | 'clientId'
  | 'pairedDeviceId'
  | 'pairedDeviceParentId'
  | 'caller'
  | 'clientKind'
  | 'clientCapabilities'
  | 'capabilitySource'
  | 'updateClientCapabilities'
  | 'pairing'
  | 'deviceSelf'
  | 'mobileRelayHosts'
  | 'peerDesktops'
  | 'delegatedMobileDevices'
  | 'sendBinary'
  | 'registerBinaryStreamHandler'
  | 'registerBinaryMessageHandler'
> & {
  /** What the transport proved the caller may do; absent means this host's owner. */
  callerScope?: RpcCallerScope
  /** Aborts when the caller's connection closes; only for the dispatcher's own waits, never handlers. */
  connectionSignal?: AbortSignal
}

export function rpcContextFromTransport(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  options: RpcDispatchStreamingOptions | undefined,
  orchestrationCaller: OrchestrationSessionCaller | undefined,
  params?: unknown
): RpcContext {
  return {
    runtime,
    signal: options?.signal,
    retainConnectionLifetime: options?.retainConnectionLifetime,
    requestId: request.id,
    connectionId: options?.connectionId,
    // Session tabs always need this fence. COMPAT(terminal request-addressed unsubscribe): terminal only for phones without `requestId`.
    // Capture before middleware yields to a replacement subscribe on the same connection.
    subscriptionRegistrationVersion: isRegistrationFencedUnsubscribe(request.method)
      ? runtime.getSubscriptionRegistrationVersion()
      : undefined,
    structuredAgentCliSourceEvidence:
      request.method === 'agentSession.create'
        ? captureStructuredAgentCliSource(
            () => runtime.getAgentProviderSessionRows(),
            cliSourceCoordinates(params),
            (source) => runtime.getStructuredAgentCliSourceRoute(source)
          )
        : undefined,
    clientId: options?.clientId,
    pairedDeviceId: options?.pairedDeviceId,
    pairedDeviceParentId: options?.pairedDeviceParentId,
    caller: resolveRpcCallerIdentity(options),
    clientKind: options?.clientKind,
    clientCapabilities: options?.clientCapabilities,
    capabilitySource: options?.capabilitySource,
    updateClientCapabilities: options?.updateClientCapabilities,
    authenticatedCallerFingerprint: options?.authenticatedCallerFingerprint,
    pairing: options?.pairing,
    deviceSelf: options?.deviceSelf,
    mobileRelayHosts: options?.mobileRelayHosts,
    peerDesktops: options?.peerDesktops,
    delegatedMobileDevices: options?.delegatedMobileDevices,
    sendBinary: options?.sendBinary,
    registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
    registerBinaryMessageHandler: options?.registerBinaryMessageHandler,
    orchestrationCaller
  }
}

function cliSourceCoordinates(params: unknown) {
  if (!params || typeof params !== 'object' || !('resumeFrom' in params)) {
    return undefined
  }
  const resume = params.resumeFrom
  if (!resume || typeof resume !== 'object' || !('cliSource' in resume)) {
    return undefined
  }
  const source = resume.cliSource
  return source &&
    typeof source === 'object' &&
    'workspaceId' in source &&
    typeof source.workspaceId === 'string' &&
    'paneKey' in source &&
    typeof source.paneKey === 'string'
    ? { workspaceId: source.workspaceId, paneKey: source.paneKey }
    : undefined
}
