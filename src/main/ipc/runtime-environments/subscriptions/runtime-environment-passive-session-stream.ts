import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import type { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { decodeRuntimeEnvironmentSubscriptionEvents } from './runtime-environment-subscription-events'

export const PASSIVE_SESSION_CLIENT_CAPABILITIES = [
  ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  IDLE_PASSIVE_CLIENT_CAPABILITY
]

export type PassiveSessionTransport = {
  resolve: (environmentId: string) => Promise<PairedRuntimeConnection | null>
  subscribe: typeof subscribeRemoteRuntimeTransport
  isManuallyDisconnected: (environmentId: string) => boolean
}

export type PassiveSessionStreamOpener = (
  environmentId: string,
  handlers: { onFrame: (frame: unknown) => void; onEnd: () => void; signal?: AbortSignal }
) => Promise<{ close: () => void } | 'unsupported'>

/** A separate passive socket observes an already-ready host without acquiring/waking its runtime. */
export function createPassiveSessionStreamOpener(
  transport: PassiveSessionTransport
): PassiveSessionStreamOpener {
  return async (environmentId, handlers) => {
    const connection = await transport.resolve(environmentId)
    if (
      handlers.signal?.aborted ||
      !connection ||
      transport.isManuallyDisconnected(environmentId)
    ) {
      return 'unsupported'
    }
    let ended = false
    const end = (): void => {
      if (!ended) {
        ended = true
        handlers.onEnd()
      }
    }
    const onEvent = decodeRuntimeEnvironmentSubscriptionEvents(
      'session.tabs.subscribeAll',
      (payload) => {
        if (ended) {
          return
        }
        if (payload.type === 'response' && payload.response.ok) {
          handlers.onFrame(payload.response.result)
        } else if (payload.type !== 'binary') {
          end()
        }
      },
      () => !ended
    )
    const subscription = await transport.subscribe(
      connection,
      'session.tabs.subscribeAll',
      {},
      15_000,
      {
        onResponse: (response) => onEvent({ type: 'response', response }),
        onError: (error) => onEvent({ type: 'error', code: error.code, message: error.message }),
        onClose: end
      },
      { clientCapabilities: PASSIVE_SESSION_CLIENT_CAPABILITIES, signal: handlers.signal }
    )
    return {
      close: () => {
        ended = true
        subscription.close()
      }
    }
  }
}
