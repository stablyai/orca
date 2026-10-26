import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../../shared/remote-runtime-client'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { sendRemoteRuntimeSharedControlRequestOnRuntime } from './runtime-environment-request-connections'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'

type PinnedCall = {
  method: string
  params: unknown
  timeoutMs: number
  envelope?: RuntimeOrchestrationEnvelope
  signal?: AbortSignal
}

/** A one-shot socket that sends only after its own `status.get` names `expectedRuntimeId`; null otherwise. */
async function sendOneShotRequestOnRuntime(
  connection: PairedRuntimeConnection,
  call: PinnedCall,
  expectedRuntimeId: string
): Promise<RuntimeRpcResponse<unknown> | null> {
  let otherRuntime = false
  try {
    return await sendRemoteRuntimeRequestWithStatusPreflight<unknown>(
      connection,
      call.method,
      call.params,
      call.timeoutMs,
      (status) => {
        otherRuntime = !status.ok || status.result.runtimeId !== expectedRuntimeId
        if (otherRuntime) {
          throw new Error('Runtime changed before sending')
        }
      },
      call.envelope,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      call.signal
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
  call: PinnedCall,
  expectedRuntimeId: string,
  transport: 'shared' | 'one-shot'
): Promise<RuntimeRpcResponse<unknown>> {
  const response =
    transport === 'shared'
      ? await sendRemoteRuntimeSharedControlRequestOnRuntime<unknown>(
          route.environment.id,
          route.connection,
          call.method,
          call.params,
          call.timeoutMs,
          expectedRuntimeId,
          call.envelope,
          call.signal
        )
      : await sendOneShotRequestOnRuntime(route.connection, call, expectedRuntimeId)
  return response ?? runtimeEnvironmentChangedFailure(route.environment, call.method)
}
