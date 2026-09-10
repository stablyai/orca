// IPC surface for per-pane RPC chat sessions (milestone 1: streaming turns
// over RPC). Acquire/release/send/abort/respond are request/response; the
// frame stream is a session-scoped push channel, following the
// `nativeChat:subscribe`-style pattern (ipcMain.on + webContents.send,
// listener-based unsubscribe in preload) rather than ipcMain.handle.
// Every handler is fail-closed — degrades the caller to PTY behavior (D1)
// instead of throwing across the IPC boundary.

import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatClaimedHandback,
  OmpRpcChatClaimPendingHandbacksIpcArgs,
  OmpRpcChatEventPayload,
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult,
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
  OmpRpcChatSubscribeArgs,
  OmpRpcChatUnsubscribeArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import { OmpRpcChatSessionRegistry } from '../omp-rpc/omp-rpc-chat-session-registry'
import {
  hasOtherLocalOmpRpcPtySessionWriter,
  isLocalOmpRpcPtyAlive,
  localOmpRpcPtyProvider,
  localOmpRpcPtySlavePath
} from '../omp-rpc/omp-rpc-local-pty-access'
import {
  claimOmpRpcPaneHandbacks,
  settleOmpRpcPaneHandback,
  clearOmpRpcPaneHandbacksForTests,
  publishOmpRpcPaneHandback
} from '../omp-rpc/omp-rpc-pane-handback-delivery'
import { releaseOmpRpcPaneWithHandback } from '../omp-rpc/omp-rpc-pane-release-handback'
import { resolveOmpRpcLaunch } from './omp-rpc'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { resolveOmpPaneSessionIdentity } from '../native-chat/omp-terminal-session-identity'
import { localOmpRpcSessionWriteFence } from '../omp-rpc/omp-rpc-local-session-write-fence'

let registry: OmpRpcChatSessionRegistry | null = null
let isShuttingDown = false
const pendingAcquireRequests = new Set<Promise<OmpRpcChatAcquireResult>>()

function getRegistry(): OmpRpcChatSessionRegistry {
  registry ??= new OmpRpcChatSessionRegistry({ writerFence: localOmpRpcSessionWriteFence })
  return registry
}

// Why: live subscriptions are keyed by (webContents.id, subscriptionId), same
// shape as native-chat.ts's transcript subscriptions, so one renderer can
// watch several panes and a destroyed window tears down all of its watchers.
const subscriptionsBySender = new Map<number, Map<string, () => void>>()
const senderCleanupRegistered = new Set<number>()

function teardownSubscription(senderId: number, subscriptionId: string): void {
  const bySubId = subscriptionsBySender.get(senderId)
  const unsubscribe = bySubId?.get(subscriptionId)
  if (!unsubscribe) {
    return
  }
  unsubscribe()
  bySubId?.delete(subscriptionId)
  if (bySubId && bySubId.size === 0) {
    subscriptionsBySender.delete(senderId)
  }
}

function teardownAllForSender(senderId: number): void {
  const bySubId = subscriptionsBySender.get(senderId)
  if (!bySubId) {
    return
  }
  for (const unsubscribe of bySubId.values()) {
    unsubscribe()
  }
  subscriptionsBySender.delete(senderId)
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => {
    teardownAllForSender(sender.id)
    senderCleanupRegistered.delete(sender.id)
  })
}

function handleSubscribe(event: IpcMainEvent, args: OmpRpcChatSubscribeArgs): void {
  const sender = event.sender
  if (sender.isDestroyed()) {
    return
  }
  teardownSubscription(sender.id, args.subscriptionId)
  const session = getRegistry().get(args.paneKey)
  if (!session) {
    return
  }
  registerSenderCleanup(sender)
  const unsubscribe = session.on((rpcEvent) => {
    if (sender.isDestroyed()) {
      return
    }
    const payload: OmpRpcChatEventPayload = { subscriptionId: args.subscriptionId, event: rpcEvent }
    sender.send('ompRpcChat:event', payload)
  })
  const bySubId = subscriptionsBySender.get(sender.id) ?? new Map<string, () => void>()
  bySubId.set(args.subscriptionId, unsubscribe)
  subscriptionsBySender.set(sender.id, bySubId)
}

export function registerOmpRpcChatHandlers(): void {
  ipcMain.handle(
    'ompRpcChat:resolveSessionIdentity',
    async (
      _event,
      args: OmpRpcChatResolveSessionIdentityArgs
    ): Promise<OmpRpcChatResolveSessionIdentityResult> => {
      const paneKey = args?.paneKey?.trim()
      const cwd = args?.cwd?.trim()
      const ptyId = args?.ptyId?.trim() || null
      if (!paneKey || !cwd) {
        return null
      }
      // Why (finding E, cross-lab review): the mtime-fallback sub-path
      // inside resolveOmpPaneSessionIdentity depends only on `cwd`, not
      // `ptyId` — unlike the breadcrumb sub-path, it has no independent
      // locality gate of its own, and the newest local session for a
      // same-named path belongs to a different repository entirely. This
      // check is the host-side half of the boundary; the renderer's half is
      // `resolveOmpRpcPaneExecutionHost` (omp-rpc-pane-locality.ts), which
      // admits only a pane whose worktree has neither a runtime owner nor an
      // SSH owner, and refuses an owner it cannot yet resolve. A null `ptyId`
      // (wave 9, Defect 1: optional accuracy input, never a precondition)
      // gives this handler nothing of its own to verify, so that renderer
      // gate is the only signal in that case — it must stay a locality test,
      // not the `runtimeEnvironmentId === null` proxy it used to be, which
      // read an `ssh:` worktree as local.
      if (ptyId && !localOmpRpcPtyProvider(ptyId)) {
        return null
      }
      try {
        const resolved = await resolveOmpPaneSessionIdentity(
          { ptyId, cwd },
          {
            getSlavePath: localOmpRpcPtySlavePath,
            // Defect 2 fix: exclude only claims held by OTHER panes — the
            // asking pane must never be denied its own claim (proven live:
            // re-resolving while holding a claim was silently handed a
            // different, older session).
            claimedSessionFilePaths: getRegistry().claimedSessionFilePathsExcluding(paneKey)
          }
        )
        return resolved ? { sessionId: resolved.sessionId, source: resolved.source } : null
      } catch {
        // Why: a filesystem read failure here must degrade to "nothing to
        // resume" (D1), never propagate across the IPC boundary as a throw.
        return null
      }
    }
  )

  ipcMain.handle(
    'ompRpcChat:acquire',
    (_event, args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> => {
      const acquire = async (): Promise<OmpRpcChatAcquireResult> => {
        // Why (F7): every await below (executable resolution, the registry's
        // spawn/handoff) can reject; the IPC boundary must never propagate a
        // throw to the renderer (D1) — degrade to the same fail-closed result
        // the registry itself already returns for its own known failures.
        try {
          const paneKey = args?.paneKey?.trim()
          // An absent `ptyId` is admitted (XLR-R6-004): a restarted renderer
          // adopting a surviving child has no PTY to hand over, and the registry
          // answers it from its existing registration alone. It stays fatal for a
          // fresh spawn, because `isLocalPtyAlive('')` cannot prove an exit and
          // the acquisition gate then fails closed on its own.
          const ptyId = args?.ptyId?.trim() ?? ''
          const cwd = args?.cwd?.trim()
          const sessionFile = args?.sessionFile?.trim()
          if (!paneKey || !cwd || !sessionFile) {
            return { ok: false, reason: 'spawn-failed' }
          }
          const launch = await resolveOmpRpcLaunch(args?.agentCommand)
          if (isShuttingDown) {
            return { ok: false, reason: 'spawn-failed' }
          }
          if (!launch) {
            return { ok: false, reason: 'executable-not-found' }
          }
          // Why (F12, live-verified against omp 18.0.6): `switch_session`'s
          // wire field is a filesystem path, not the bare session id this
          // milestone's callers pass — a bare id neither throws nor switches,
          // so acquisition must resolve the real transcript file first or it
          // silently never engages RPC for any pane.
          const sessionFilePath = await resolveSessionFilePath('omp', sessionFile)
          if (isShuttingDown) {
            return { ok: false, reason: 'spawn-failed' }
          }
          if (!sessionFilePath) {
            return { ok: false, reason: 'spawn-failed' }
          }
          const result = await getRegistry().acquire({
            paneKey,
            ptyId,
            cwd,
            ...launch,
            sessionFile,
            sessionFilePath,
            isPtyAlive: isLocalOmpRpcPtyAlive,
            hasOtherPtySessionWriter: hasOtherLocalOmpRpcPtySessionWriter,
            // Why (XLR-045, cross-lab review): an initialization failure whose
            // child exit could not be proven travels as `rpc-child-unverifiable`,
            // which owes the pane neither a respawn nor the pre-kill undo — it
            // keeps no terminal until that child is provably gone. Nothing else
            // ever revisits it: the renderer never acquired, so it fires no
            // release, and the pane's PTY was killed to admit the spawn. This is
            // the same hand-back push a settled release sends, on the same
            // durable listener, just triggered by the exit itself.
            onLateRpcChildExit: () => {
              publishOmpRpcPaneHandback({
                paneKey,
                replacedPtyId: ptyId,
                cwd,
                sessionId: sessionFile
              })
            }
          })
          if (result.status === 'acquired') {
            return { ok: true }
          }
          // Why each of the three travels under its own name (XLR-041): the
          // renderer's killed-PTY recovery is a different decision for a verdict
          // about the pane's PTY than for one about the RPC child main spawned
          // beside it, and collapsing them fed it the wrong one.
          if (
            result.status === 'live' ||
            result.status === 'unverifiable' ||
            result.status === 'rpc-child-unverifiable'
          ) {
            return { ok: false, reason: result.status }
          }
          return { ok: false, reason: result.status === 'conflict' ? 'conflict' : 'spawn-failed' }
        } catch {
          return { ok: false, reason: 'spawn-failed' }
        }
      }
      const request = acquire()
      pendingAcquireRequests.add(request)
      void request.finally(() => pendingAcquireRequests.delete(request))
      return request
    }
  )

  // Whether main still owns this pane's RPC child. Read-only, and the gate on a
  // restarted renderer re-engaging a pane whose PTY binding acquisition already
  // cleared (XLR-R6-004): without it the new document is ineligible forever and
  // the surviving child has neither a chat owner nor anyone to release it.
  ipcMain.handle(
    'ompRpcChat:hasSession',
    (_event, args: OmpRpcChatHasSessionArgs): OmpRpcChatHasSessionResult => {
      const paneKey = args?.paneKey?.trim()
      const sessionFile = paneKey ? getRegistry().getSessionFile(paneKey) : null
      return sessionFile ? { sessionFile } : null
    }
  )

  ipcMain.handle(
    'ompRpcChat:release',
    async (_event, args: OmpRpcChatReleaseArgs): Promise<OmpRpcChatReleaseResult> => {
      const paneKey = args?.paneKey?.trim()
      if (!paneKey) {
        return { released: false }
      }
      // The release ordering, the hand-back push a settled one earns, and the
      // settlement-triggered continuation a REFUSED one leaves behind all live
      // in omp-rpc-pane-release-handback.ts (XLR-R6-003): the renderer's own
      // retries are bounded, so main holds the remainder. The requesting sender
      // may have navigated away, reloaded or closed by the time any of it
      // resolves (a release can take up to the settle-wait's bound, and the
      // continuation far longer), which is why the hand-back is retained and
      // broadcast rather than pushed back down this one channel (XLR-R7-001).
      return await releaseOmpRpcPaneWithHandback({
        paneKey,
        registry: getRegistry(),
        respawn: args.respawn,
        sendHandback: publishOmpRpcPaneHandback
      })
    }
  )

  // The consume half of the hand-back (XLR-R7-001): the nudge above only tells
  // renderers to come and look, and this claim is what authorizes a respawn.
  // Every durable listener also claims on mount, which is the only signal a
  // renderer that reloaded past the nudge ever produces. The claim only LEASES
  // the instruction to the asking DOCUMENT (XLR-R8-001, XLR-R9-001) — main
  // keeps it until `settleHandback` reports a respawn that actually happened.
  ipcMain.handle(
    'ompRpcChat:claimPendingHandbacks',
    (event, args: OmpRpcChatClaimPendingHandbacksIpcArgs): OmpRpcChatClaimedHandback[] => {
      const tabId = args?.tabId?.trim()
      return tabId ? claimOmpRpcPaneHandbacks(tabId, event.sender.id, args?.claimantDocumentId) : []
    }
  )

  ipcMain.handle('ompRpcChat:settleHandback', (_event, args: OmpRpcChatSettleHandbackArgs): void =>
    settleOmpRpcPaneHandback(args)
  )

  ipcMain.handle(
    'ompRpcChat:fetchHistory',
    async (_event, args: OmpRpcChatFetchHistoryArgs): Promise<OmpRpcChatFetchHistoryResult> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: 'unavailable' }
      }
      return session.fetchHistory(args?.limit === undefined ? {} : { limit: args.limit })
    }
  )

  ipcMain.handle(
    'ompRpcChat:send',
    async (_event, args: OmpRpcChatSendArgs): Promise<OmpRpcChatSendResult> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: 'no RPC-owned session for this pane' }
      }
      return session.send({
        message: args.message,
        images: args.images,
        behavior: args.behavior,
        requestId: args.requestId
      })
    }
  )

  ipcMain.handle(
    'ompRpcChat:abort',
    async (_event, args: OmpRpcChatAbortArgs): Promise<OmpRpcChatSendResult> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: 'no RPC-owned session for this pane' }
      }
      return session.abort()
    }
  )

  ipcMain.handle(
    'ompRpcChat:respondExtensionUi',
    async (_event, args: OmpRpcChatRespondExtensionUiArgs): Promise<boolean> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return false
      }
      return session.respondExtensionUi(args.response)
    }
  )

  ipcMain.on('ompRpcChat:subscribe', (event, args: OmpRpcChatSubscribeArgs) => {
    handleSubscribe(event, args)
  })
  ipcMain.on('ompRpcChat:unsubscribe', (event, args: OmpRpcChatUnsubscribeArgs) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })
}

/** App-quit teardown, joined into the application's will-quit barrier by
 *  src/main/index.ts rather than registered on `will-quit` here (XLR-R6-005,
 *  cross-lab review). A listener of its own could only fire and forget: quit
 *  then reached `app.quit()` while the RPC children were still only SIGTERMed,
 *  and one that delayed or ignored the signal kept writing its session past the
 *  app's death — where a relaunched Orca's PTY or RPC child becomes a second
 *  writer on it. The barrier's own deadline bounds this. */
export function shutdownOmpRpcChatSessions(): Promise<void> {
  isShuttingDown = true
  const disposal = registry?.disposeAll() ?? Promise.resolve()
  return Promise.allSettled([...pendingAcquireRequests, disposal]).then(() => undefined)
}

/** Test-only: drop all live subscriptions and the registry between runs. */
export function clearOmpRpcChatHandlersForTests(): void {
  for (const senderId of subscriptionsBySender.keys()) {
    teardownAllForSender(senderId)
  }
  senderCleanupRegistered.clear()
  clearOmpRpcPaneHandbacksForTests()
  void registry?.disposeAll()
  registry = null
  isShuttingDown = false
  pendingAcquireRequests.clear()
}
