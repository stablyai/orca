import { LEGACY_JOURNAL_RETIREMENT_AVAILABLE } from '../../../../shared/remote-runtime/protocol/legacy-journal-retirement-forwarding'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  getReadyRemoteRuntimeSharedControlConnection,
  subscribeRemoteRuntimeSharedControlRequest
} from '../connections/runtime-environment-request-connections'
import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RemoteLegacyJournalRetirement } from './remote-legacy-journal-retirement'

let disabledSocketGenerations: WeakMap<RemoteRuntimeSharedControlConnection, number> | undefined

function captureRemoteRuntimeRetirementSocket(
  connection: RemoteRuntimeSharedControlConnection,
  isCurrent: () => boolean
) {
  const generation = connection.socketGeneration.peek()
  const isDisabled = () => disabledSocketGenerations?.get(connection) === generation
  if (isDisabled()) {
    return undefined
  }
  return {
    ...connection.captureReadySocket(() => !isDisabled() && isCurrent()),
    disableForwarding: () => {
      if (connection.socketGeneration.isCurrent(generation)) {
        disabledSocketGenerations ??= new WeakMap()
        disabledSocketGenerations.set(connection, generation)
      }
    }
  }
}

export type RetirementEventSocket = NonNullable<
  ReturnType<typeof captureRemoteRuntimeRetirementSocket>
>

type Ready = {
  subscriptionId: string
  runtimeId: string
  socket: RetirementEventSocket
  loading?: true
  receiver?: RemoteLegacyJournalRetirement
}

export async function subscribeRuntimeEnvironmentWithRetirementEvents(
  isCurrent: () => boolean,
  ...args: Parameters<typeof subscribeRemoteRuntimeSharedControlRequest>
) {
  const [environmentId, connection, method, params, timeoutMs, callbacks, signal] = args
  if (method !== 'runtime.clientEvents.subscribe') {
    return subscribeRemoteRuntimeSharedControlRequest(...args)
  }
  const retirement = observeRemoteLegacyJournalRetirement(
    environmentId,
    connection,
    () => !signal?.aborted && isCurrent()
  )
  const subscription = await subscribeRemoteRuntimeSharedControlRequest(
    environmentId,
    connection,
    method,
    params,
    timeoutMs,
    {
      ...callbacks,
      onResponse: (response) => {
        try {
          retirement.onResponse(response)
        } catch {
          // Telemetry cannot interrupt normal client events.
        }
        callbacks.onResponse(response)
      },
      onError: (error) => {
        retirement.close()
        callbacks.onError(error)
      },
      onClose: () => {
        retirement.close()
        callbacks.onClose?.()
      }
    },
    signal
  )
  return {
    ...subscription,
    close: () => {
      retirement.close()
      subscription.close()
    }
  }
}

function observeRemoteLegacyJournalRetirement(
  environmentId: string,
  connection: PairedRuntimeConnection,
  isCurrent: () => boolean
) {
  let ready: Ready | undefined
  const close = () => {
    ready?.receiver?.close()
    ready = undefined
  }

  const available = (stream: Ready) => {
    if (!stream.socket.isCurrent()) {
      return
    }
    if (stream.receiver) {
      stream.receiver.available()
    } else if (!stream.loading) {
      stream.loading = true
      void import('./remote-legacy-journal-retirement')
        .then(({ RemoteLegacyJournalRetirement }) => {
          if (ready === stream && stream.socket.isCurrent()) {
            stream.receiver = new RemoteLegacyJournalRetirement(
              stream.socket,
              stream.subscriptionId,
              stream.runtimeId
            )
            stream.receiver.available()
          }
        })
        .catch(() => {})
    }
  }

  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      close()
      return
    }
    const event = response.result
    if (typeof event !== 'object' || event === null || !('type' in event)) {
      return
    }
    if (event.type === 'end') {
      close()
    } else if (event.type === 'ready') {
      close()
      if (
        !isCurrent() ||
        !('legacyJournalRetirementAvailable' in event) ||
        typeof event.legacyJournalRetirementAvailable !== 'boolean' ||
        !('subscriptionId' in event) ||
        typeof event.subscriptionId !== 'string' ||
        event.subscriptionId.length === 0 ||
        event.subscriptionId.length > 256
      ) {
        return
      }
      const shared = getReadyRemoteRuntimeSharedControlConnection(environmentId, connection)
      const socket = shared && captureRemoteRuntimeRetirementSocket(shared, isCurrent)
      if (socket) {
        ready = {
          socket,
          subscriptionId: event.subscriptionId,
          runtimeId: response._meta.runtimeId
        }
        if (event.legacyJournalRetirementAvailable) {
          available(ready)
        }
      }
    } else if (
      event.type === LEGACY_JOURNAL_RETIREMENT_AVAILABLE &&
      ready &&
      ready.runtimeId === response._meta.runtimeId &&
      Object.keys(event).length === 1
    ) {
      available(ready)
    }
  }

  return { onResponse, close }
}
