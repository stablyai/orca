import { ipcMain, webContents, type IpcMainEvent, type WebContents } from 'electron'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { clearNativeChatTranscriptCache } from '../native-chat/transcript-read-cache'
import type { ReadTranscriptResult } from '../native-chat/transcript-reader'
import type { NativeChatTranscriptSubscription } from '../native-chat/transcript-watch'
// Why the dispatcher rather than transcript-watch directly: an agent's
// conversation arrives either from its own JSONL transcript or over ACP, and the
// transport is resolved per agent (source-dispatch.ts).
import {
  readNativeChatSessionTail,
  subscribeNativeChatSession
} from '../native-chat/source-dispatch'
import {
  createAcpPermissionRegistry,
  type AcpPermissionPrompt
} from '../native-chat/acp-permission-registry'

// Re-export so existing test imports of `clearNativeChatTranscriptCache` from
// this module keep working after the cache moved to transcript-read-cache.ts.
export { clearNativeChatTranscriptCache }

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** How many of the most-recent turns to return. The renderer starts at the
   *  default window and raises this to page in older history as it scrolls up. */
  limit?: number
  /** Authoritative transcript path from the agent hook (providerSession), used to
   *  locate the file when the session id no longer names it (recent Claude Code). */
  transcriptPath?: string
}

// Why: render and parse only the recent window so long transcripts do not stall
// either the main process or the message list. Pagination raises this limit.
const DESKTOP_READ_WINDOW = 300

async function readSession(args: NativeChatReadSessionArgs): Promise<ReadTranscriptResult> {
  const { agent, sessionId } = args
  // Clamp to a positive window; default to the desktop window for the first page.
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  return readNativeChatSessionTail({
    agent,
    sessionId,
    transcriptPath: args.transcriptPath,
    limit
  })
}

export type NativeChatSubscribeArgs = {
  /** Renderer-minted id, unique per webContents, echoed back on every emit so
   *  the renderer can route appends to the right hook instance. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  limit?: number
}

export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame:
    | {
        type: 'snapshot'
        messages: NativeChatMessage[]
        hasMore: boolean
        error?: string
        lifecycle?: NativeChatTurnLifecycle
      }
    | {
        type: 'replacement'
        messages: NativeChatMessage[]
        hasMore: boolean
        lifecycle?: NativeChatTurnLifecycle
      }
    | {
        type: 'appended'
        messages: NativeChatMessage[]
        lifecycle?: NativeChatTurnLifecycle
      }
}

type LiveSubscription = {
  subscription: NativeChatTranscriptSubscription
}

// An ACP agent blocks its turn until the client answers a permission request, so
// the registry guarantees every request reaches an operator choice or a cancel —
// including on teardown paths, where a dropped request would hang the agent.
const acpPermissions = createAcpPermissionRegistry((senderId, prompt) => {
  const sender = webContents.fromId(senderId)
  if (sender == null || sender.isDestroyed()) {
    throw new Error('renderer unavailable for ACP permission prompt')
  }
  sender.send('nativeChat:acpPermissionRequested', prompt)
})

export type { AcpPermissionPrompt }

// Why: live subscriptions are keyed by (webContents.id, subscriptionId) so the
// same renderer can watch several panes, and a destroyed window tears down all
// of its watchers — strict teardown to avoid fd leaks (plan U4 risk).
const liveSubscriptions = new Map<number, Map<string, LiveSubscription>>()
// Why: unsubscribe and renderer destruction must invalidate async watcher setup
// before it can publish a late subscription into the live map.
const pendingSubscriptions = new Map<number, Map<string, symbol>>()
const senderCleanupRegistered = new Set<number>()

function teardownSubscription(senderId: number, subscriptionId: string): void {
  const pendingBySubId = pendingSubscriptions.get(senderId)
  pendingBySubId?.delete(subscriptionId)
  if (pendingBySubId?.size === 0) {
    pendingSubscriptions.delete(senderId)
  }
  const bySubId = liveSubscriptions.get(senderId)
  const live = bySubId?.get(subscriptionId)
  if (!live || !bySubId) {
    return
  }
  live.subscription.unsubscribe()
  acpPermissions.cancelSubscription(senderId, subscriptionId)
  bySubId.delete(subscriptionId)
  if (bySubId.size === 0) {
    liveSubscriptions.delete(senderId)
  }
}

function teardownAllForSender(senderId: number): void {
  // The destroyed event can arrive before async subscription setup stores a watcher.
  senderCleanupRegistered.delete(senderId)
  pendingSubscriptions.delete(senderId)
  const bySubId = liveSubscriptions.get(senderId)
  if (!bySubId) {
    return
  }
  for (const live of bySubId.values()) {
    live.subscription.unsubscribe()
  }
  acpPermissions.cancelSender(senderId)
  liveSubscriptions.delete(senderId)
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  // Strict teardown: a closed/reloaded window releases every watcher it owns.
  sender.once('destroyed', () => {
    teardownAllForSender(sender.id)
    // Belt and braces: a request can be outstanding before any subscription is
    // stored in the live map.
    acpPermissions.cancelSender(sender.id)
  })
}

function beginPendingSubscription(senderId: number, subscriptionId: string): symbol {
  teardownSubscription(senderId, subscriptionId)
  const token = Symbol(subscriptionId)
  const bySubId = pendingSubscriptions.get(senderId) ?? new Map<string, symbol>()
  bySubId.set(subscriptionId, token)
  pendingSubscriptions.set(senderId, bySubId)
  return token
}

function takePendingSubscription(senderId: number, subscriptionId: string, token: symbol): boolean {
  const bySubId = pendingSubscriptions.get(senderId)
  if (bySubId?.get(subscriptionId) !== token) {
    return false
  }
  bySubId.delete(subscriptionId)
  if (bySubId.size === 0) {
    pendingSubscriptions.delete(senderId)
  }
  return true
}

async function handleSubscribe(event: IpcMainEvent, args: NativeChatSubscribeArgs): Promise<void> {
  const sender = event.sender
  if (sender.isDestroyed()) {
    return
  }
  const { subscriptionId, agent, sessionId, transcriptPath } = args
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  // Replace any prior subscription under the same id (session change/resubscribe).
  const pendingToken = beginPendingSubscription(sender.id, subscriptionId)
  registerSenderCleanup(sender)

  let subscription: NativeChatTranscriptSubscription
  try {
    subscription = await subscribeNativeChatSession({
      agent,
      sessionId,
      transcriptPath,
      initialLimit: limit,
      onPermissionRequest: (params) =>
        acpPermissions.request({ senderId: sender.id, subscriptionId, params }),
      onLog: (line) => {
        // ACP agents report startup and errors on stderr; keep it in the main
        // log rather than the renderer, which only shows conversation content.
        console.warn(`[native-chat:acp] ${line}`)
      },
      onInitialSnapshot: (messages, hasMore, _beforeOffset, error, lifecycle) => {
        if (sender.isDestroyed()) {
          return
        }
        // Forward an initial-drain error so a watching client's first frame carries it
        // instead of stranding the view at 'loading' when the read keeps throwing.
        const payload: NativeChatAppendedPayload = {
          subscriptionId,
          frame: {
            type: 'snapshot',
            messages,
            hasMore,
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {})
          }
        }
        sender.send('nativeChat:appended', payload)
      },
      onReplace: (messages, hasMore, _beforeOffset, lifecycle) => {
        if (sender.isDestroyed()) {
          return
        }
        sender.send('nativeChat:appended', {
          subscriptionId,
          frame: {
            type: 'replacement',
            messages,
            hasMore,
            ...(lifecycle ? { lifecycle } : {})
          }
        } satisfies NativeChatAppendedPayload)
      },
      onAppend: (messages, lifecycle) => {
        if (sender.isDestroyed()) {
          return
        }
        const payload: NativeChatAppendedPayload = {
          subscriptionId,
          frame: {
            type: 'appended',
            messages,
            ...(lifecycle ? { lifecycle } : {})
          }
        }
        sender.send('nativeChat:appended', payload)
      }
    })
  } catch {
    takePendingSubscription(sender.id, subscriptionId, pendingToken)
    return
  }

  // Why: unmount, destruction, or a newer same-id subscribe can invalidate setup
  // while path resolution is pending; only the owning token may publish its watcher.
  const stillCurrent = takePendingSubscription(sender.id, subscriptionId, pendingToken)
  if (sender.isDestroyed() || !stillCurrent) {
    subscription.unsubscribe()
    return
  }
  const bySubId = liveSubscriptions.get(sender.id) ?? new Map<string, LiveSubscription>()
  // A concurrent subscribe with the same id beat us here; honor the latest.
  const existing = bySubId.get(subscriptionId)
  if (existing) {
    existing.subscription.unsubscribe()
  }
  bySubId.set(subscriptionId, { subscription })
  liveSubscriptions.set(sender.id, bySubId)
  if (!subscription.watching && !sender.isDestroyed()) {
    const payload: NativeChatAppendedPayload = {
      subscriptionId,
      frame: {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: 'Transcript unavailable'
      }
    }
    sender.send('nativeChat:appended', payload)
  }
}

export function _getAcpPendingPermissionCountForTest(): number {
  return acpPermissions.pendingCount
}

/** Test-only: drop all live and pending transcript subscriptions between runs. */
export function clearNativeChatSubscriptions(): void {
  const senderIds = new Set([...liveSubscriptions.keys(), ...pendingSubscriptions.keys()])
  for (const senderId of senderIds) {
    teardownAllForSender(senderId)
  }
  pendingSubscriptions.clear()
  senderCleanupRegistered.clear()
}

export function _getNativeChatSenderCleanupCountForTest(): number {
  return senderCleanupRegistered.size
}

export function _getNativeChatPendingSubscriptionCountForTest(): number {
  let count = 0
  for (const bySubId of pendingSubscriptions.values()) {
    count += bySubId.size
  }
  return count
}

export function registerNativeChatHandlers(): void {
  ipcMain.handle('nativeChat:readSession', (_event, args: NativeChatReadSessionArgs) =>
    readSession(args)
  )
  ipcMain.on('nativeChat:subscribe', (event, args: NativeChatSubscribeArgs) => {
    void handleSubscribe(event, args)
  })
  ipcMain.on('nativeChat:unsubscribe', (event, args: { subscriptionId: string }) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })
  // `optionId: null` is the operator dismissing the card — an explicit cancel,
  // never an implicit allow.
  ipcMain.handle(
    'nativeChat:acpPermissionRespond',
    (_event, args: { requestId: string; optionId: string | null }) =>
      acpPermissions.respond(args.requestId, args.optionId)
  )
}
