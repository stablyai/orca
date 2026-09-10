import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatClaimedHandback,
  OmpRpcChatClaimPendingHandbacksArgs,
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

export type OmpRpcChatApi = {
  /** Resolves a pane's OMP session identity from OMP's own on-disk state
   *  (terminal breadcrumb, then newest-by-mtime cwd bucket) — bypasses the
   *  broken agent-status hook chain. Null means nothing to resume. */
  resolveSessionIdentity: (
    args: OmpRpcChatResolveSessionIdentityArgs
  ) => Promise<OmpRpcChatResolveSessionIdentityResult>
  /** Proof-gated acquisition of RPC ownership for a pane's OMP session.
   *  Fail-closed: `ok:false` means the caller must keep today's PTY behavior. */
  acquire: (args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>
  /** Whether main still holds an RPC session for this pane — what lets a
   *  restarted renderer re-engage a pane whose PTY binding acquisition already
   *  cleared, instead of leaving the child with no owner (XLR-R6-004). */
  hasSession: (args: OmpRpcChatHasSessionArgs) => Promise<OmpRpcChatHasSessionResult>
  /** Always disposes the RPC child if one is held for this pane. */
  release: (args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>
  /** Drains the owned session's paged history for reconnect hydration, decoded
   *  into the same message shape the transcript reader produces. Fail-closed:
   *  `session-busy` is retry-once-idle, `unavailable` degrades to transcript
   *  only. */
  fetchHistory: (args: OmpRpcChatFetchHistoryArgs) => Promise<OmpRpcChatFetchHistoryResult>
  send: (args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>
  abort: (args: OmpRpcChatAbortArgs) => Promise<OmpRpcChatSendResult>
  respondExtensionUi: (args: OmpRpcChatRespondExtensionUiArgs) => Promise<boolean>
  /** Start receiving turn-lifecycle frames for an already-acquired pane.
   *  Returns an unsubscribe fn that closes the watcher (nativeChat.subscribe
   *  pattern: ipcMain.on + webContents.send, listener-based unsubscribe here). */
  subscribe: (
    args: OmpRpcChatSubscribeArgs,
    onEvent: (event: OmpRpcClientEvent) => void
  ) => () => void
  /** Pushed once a `release({ respawn })` genuinely settles+exits (Critical
   *  B, wave 5) — a durable listener (TerminalPane, via
   *  use-omp-rpc-chat-handback-listener.ts) performs the actual PTY
   *  respawn, since the hook that requested release may already be
   *  unmounted by the time this arrives. Not scoped like `subscribe`: every
   *  window listens and filters by `paneKey` itself. */
  onHandback: (onEvent: (payload: OmpRpcChatHandbackPayload) => void) => () => void
  /** Takes the hand-backs main retained for this tab's panes — the consume that
   *  authorizes a respawn (XLR-R7-001). `onHandback` is only a nudge: a
   *  completed release must not lose the pane's PTY just because the requesting
   *  renderer reloaded, so the durable listener claims on mount as well. */
  claimPendingHandbacks: (
    args: OmpRpcChatClaimPendingHandbacksArgs
  ) => Promise<OmpRpcChatClaimedHandback[]>
  /** Reports what became of a leased hand-back (XLR-R8-001). Until this says a
   *  respawn happened, main keeps the instruction, so a reload or a rejected
   *  `pty.spawn` leaves the pane recoverable by the next mount's claim. */
  settleHandback: (args: OmpRpcChatSettleHandbackArgs) => Promise<void>
}
