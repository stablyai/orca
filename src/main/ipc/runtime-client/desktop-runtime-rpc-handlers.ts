import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../../../shared/agent-session/agent-session-wire'
import { LOCAL_READ_PROVIDER_RECEIPTS } from '../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-read-provider-receipts'
import {
  LOCAL_STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD,
  STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD
} from '../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-subscribe-method'
import type { RpcAnyMethodDeclaration } from '../../runtime/rpc/core'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../../runtime/rpc/callers/rpc-caller-identity'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { DesktopRuntimeSenderLifecycle } from './desktop-runtime-sender-lifecycle'
import { DesktopProviderReceiptPort } from './desktop-provider-receipt-port'

export function registerDesktopRuntimeRpcHandlers(runtime: OrcaRuntimeService): void {
  const desktopSenders = new DesktopRuntimeSenderLifecycle(runtime)
  ipcMain.removeHandler('runtime:call')
  ipcMain.removeHandler('runtime:subscribe')
  ipcMain.removeAllListeners('runtime:unsubscribe')
  // Registry build walks every method; do it once, not per IPC call.
  const readers = new ProviderReceiptReaders(() => runtime.getRuntimeId())
  const methods: readonly RpcAnyMethodDeclaration[] = ALL_RPC_METHODS
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: methods.map((method) =>
      method === STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD
        ? LOCAL_STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD
        : method
    )
  })
  const receiptPort = new DesktopProviderReceiptPort(
    readers,
    new RpcDispatcher({ runtime, methods: [LOCAL_READ_PROVIDER_RECEIPTS] })
  )

  ipcMain.handle(
    'runtime:call',
    async (
      event,
      args: {
        method: string
        params?: unknown
        orchestration?: { contractVersion: number; requestId: string }
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Runtime RPC call must originate from the current main frame')
      }
      return dispatcher.dispatch(
        {
          id: 'desktop-ipc',
          authToken: 'desktop-ipc',
          // The renderer ships with this main process, so it always speaks the current contract.
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          method: args.method,
          params: args.params,
          ...(args.orchestration
            ? {
                orchestrationContractVersion: args.orchestration.contractVersion,
                orchestrationRequestId: args.orchestration.requestId
              }
            : {})
        },
        {
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId: desktopSenders.connectionIdFor(event.sender),
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      )
    }
  )

  ipcMain.handle(
    'runtime:subscribe',
    (event, args: { subscriptionId: string; method: string; params?: unknown }) => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Runtime subscription must originate from the current main frame')
      }
      const senderSubscriptions = desktopSenders.subscriptionsFor(event.sender)
      const connectionId = desktopSenders.connectionIdFor(event.sender)
      const previous = senderSubscriptions.get(args.subscriptionId)
      previous?.abort()
      const controller = new AbortController()
      senderSubscriptions.set(args.subscriptionId, controller)
      const wantsReceipt =
        args.method === LOCAL_STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD.name &&
        typeof args.subscriptionId === 'string' &&
        args.subscriptionId.length <= AGENT_SESSION_ID_MAX_LENGTH &&
        args.params &&
        typeof args.params === 'object' &&
        'receiptReader' in args.params
      const receiptEndpoint = wantsReceipt ? receiptPort.endpointFor(event) : undefined
      const channel = `runtime:subscription:${args.subscriptionId}`
      // Streaming outlives dispatch setup; unsubscribe or sender retirement owns cancellation.
      let receiptAttached = false
      const subscribed = dispatcher.dispatchStreamingObjects(
        {
          id: args.subscriptionId,
          authToken: 'desktop-ipc',
          method: args.method,
          params: args.params
        },
        (response) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) {
            event.sender.send(channel, response)
          }
        },
        {
          signal: controller.signal,
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId,
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
          ...(receiptEndpoint
            ? {
                localProviderReceipts: {
                  endpoint: receiptEndpoint,
                  readers,
                  attached: (attached) => {
                    receiptAttached = attached
                  }
                }
              }
            : {})
        }
      )
      if (wantsReceipt) {
        return subscribed.then(() => ({ subscribed: true, receiptAttached }))
      }
      return { subscribed: true }
    }
  )

  ipcMain.on('runtime:unsubscribe', (event, args: { subscriptionId?: string }) => {
    if (args.subscriptionId !== undefined) {
      const senderSubscriptions = desktopSenders.existingSubscriptionsFor(event.sender)
      senderSubscriptions?.get(args.subscriptionId)?.abort()
      senderSubscriptions?.delete(args.subscriptionId)
    }
  })
}
