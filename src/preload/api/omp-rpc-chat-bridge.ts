import { ipcRenderer } from 'electron'
import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatClaimPendingHandbacksArgs,
  OmpRpcChatClaimPendingHandbacksIpcArgs,
  OmpRpcChatClaimedHandback,
  OmpRpcChatEventPayload,
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult,
  OmpRpcChatHandbackPayload,
  OmpRpcChatHasSessionArgs,
  OmpRpcChatHasSessionResult,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSettleHandbackArgs,
  OmpRpcChatSubscribeArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'
import type { PreloadApi } from '../api-types'

/** Identifies THIS document to main's hand-back lease (XLR-R9-001). Minted at
 *  preload scope, so it is reborn on every page load and shared by every
 *  claim the loaded document makes — which is exactly the discrimination main
 *  needs: a reload may take back a lease its predecessor will never settle, but
 *  one live listener claiming on mount and again per nudge may not, or two
 *  `omp --resume` children end up writing one session file. */
const HANDBACK_CLAIMANT_DOCUMENT_ID = crypto.randomUUID()

export const ompRpcChatApi = {
  resolveSessionIdentity: (
    args: OmpRpcChatResolveSessionIdentityArgs
  ): Promise<OmpRpcChatResolveSessionIdentityResult> =>
    ipcRenderer.invoke('ompRpcChat:resolveSessionIdentity', args),
  acquire: (args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> =>
    ipcRenderer.invoke('ompRpcChat:acquire', args),
  hasSession: (args: OmpRpcChatHasSessionArgs): Promise<OmpRpcChatHasSessionResult> =>
    ipcRenderer.invoke('ompRpcChat:hasSession', args),
  release: (args: OmpRpcChatReleaseArgs): Promise<OmpRpcChatReleaseResult> =>
    ipcRenderer.invoke('ompRpcChat:release', args),
  fetchHistory: (args: OmpRpcChatFetchHistoryArgs): Promise<OmpRpcChatFetchHistoryResult> =>
    ipcRenderer.invoke('ompRpcChat:fetchHistory', args),
  send: (args: OmpRpcChatSendArgs): Promise<OmpRpcChatSendResult> =>
    ipcRenderer.invoke('ompRpcChat:send', args),
  abort: (args: OmpRpcChatAbortArgs): Promise<OmpRpcChatSendResult> =>
    ipcRenderer.invoke('ompRpcChat:abort', args),
  respondExtensionUi: (args: OmpRpcChatRespondExtensionUiArgs): Promise<boolean> =>
    ipcRenderer.invoke('ompRpcChat:respondExtensionUi', args),
  subscribe: (
    args: OmpRpcChatSubscribeArgs,
    onEvent: (event: OmpRpcClientEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: OmpRpcChatEventPayload) => {
      if (payload.subscriptionId === args.subscriptionId) {
        onEvent(payload.event)
      }
    }
    ipcRenderer.on('ompRpcChat:event', listener)
    ipcRenderer.send('ompRpcChat:subscribe', args)
    return () => {
      ipcRenderer.removeListener('ompRpcChat:event', listener)
      ipcRenderer.send('ompRpcChat:unsubscribe', { subscriptionId: args.subscriptionId })
    }
  },
  onHandback: (onEvent: (payload: OmpRpcChatHandbackPayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: OmpRpcChatHandbackPayload
    ): void => onEvent(payload)
    ipcRenderer.on('ompRpcChat:handback', listener)
    return () => ipcRenderer.removeListener('ompRpcChat:handback', listener)
  },
  claimPendingHandbacks: (
    args: OmpRpcChatClaimPendingHandbacksArgs
  ): Promise<OmpRpcChatClaimedHandback[]> => {
    const ipcArgs: OmpRpcChatClaimPendingHandbacksIpcArgs = {
      ...args,
      claimantDocumentId: HANDBACK_CLAIMANT_DOCUMENT_ID
    }
    return ipcRenderer.invoke('ompRpcChat:claimPendingHandbacks', ipcArgs)
  },
  settleHandback: (args: OmpRpcChatSettleHandbackArgs): Promise<void> =>
    ipcRenderer.invoke('ompRpcChat:settleHandback', args)
} satisfies PreloadApi['ompRpcChat']
