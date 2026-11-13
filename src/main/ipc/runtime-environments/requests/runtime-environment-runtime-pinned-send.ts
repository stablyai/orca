import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { sendRemoteRuntimeRequestAbortable } from './runtime-environment-abortable-requests'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { sendRemoteRuntimeSharedControlRequestOnRuntime } from '../connections/runtime-environment-request-connections'
import type { RuntimeEnvironmentCall } from './runtime-environment-call'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'

/** A one-shot socket that sends only after its own `status.get` names `expectedRuntimeId`; null otherwise. */
async function sendOneShotRequestOnRuntime(
  connection: PairedRuntimeConnection,
  call: RuntimeEnvironmentCall,
  expectedRuntimeId: string
): Promise<RuntimeRpcResponse<unknown> | null> {
  let otherRuntime = false
  try {
    const requestMethod = call.method
    const requestParams = call.params
    const requestTimeoutMs = call.timeoutMs
    const orchestrationEnvelope = call.envelope
    const requestSignal = call.signal
    const requestPreparation = call.prepareRequest
    return await sendRemoteRuntimeRequestOnSocket<unknown>(
      connection,
      requestMethod,
      requestParams,
      requestTimeoutMs,
      orchestrationEnvelope,
      (status) => {
        otherRuntime = !status.ok || status.result.runtimeId !== expectedRuntimeId
        if (otherRuntime) {
          throw new Error('Runtime changed before sending')
        }
      },
      requestSignal,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      undefined,
      requestPreparation,
      undefined,
      call.prepareGuard
    )
  } catch (error) {
    if (otherRuntime) {
      return null
    }
    throw error
  }
}

/** Cached support identity can survive server restart; verify identity on the sending socket. */
export async function sendSupportRoutedCallOnRuntime(
  route: { environment: KnownRuntimeEnvironment; connection: PairedRuntimeConnection },
  call: RuntimeEnvironmentCall,
  expectedRuntimeId: string,
  transport: 'shared' | 'one-shot'
): Promise<RuntimeRpcResponse<unknown>> {
  const response =
    transport === 'shared'
      ? await sendRemoteRuntimeSharedControlRequestOnRuntime<unknown>(
          route.environment.id,
          route.connection,
          call,
          expectedRuntimeId
        )
      : await sendOneShotRequestOnRuntime(route.connection, call, expectedRuntimeId)
  return response ?? runtimeEnvironmentChangedFailure(route.environment, call.method)
}

/** One-shot enveloped call; a pinned one proves its runtime on the sending socket, since the registry's id can predate a restart. */
export function sendEnvelopedOneShotCall(
  route: { environment: KnownRuntimeEnvironment; connection: PairedRuntimeConnection },
  call: RuntimeEnvironmentCall,
  expectedRuntimeId: string | undefined
): Promise<RuntimeRpcResponse<unknown>> {
  return expectedRuntimeId === undefined
    ? sendRemoteRuntimeRequestAbortable(
        route.connection,
        call.method,
        call.params,
        call.timeoutMs,
        call.envelope,
        call.signal,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
        call.prepareRequest,
        call.prepareGuard
      )
    : sendSupportRoutedCallOnRuntime(route, call, expectedRuntimeId, 'one-shot')
}
