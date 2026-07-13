import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from '../native-chat/transcript-read-cache'
import type { ReadTranscriptResult } from '../native-chat/transcript-reader'
import {
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription
} from '../native-chat/transcript-watch'

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

// Why: render only the most recent turns so switching to chat view on a long
// session (thousands of messages) doesn't stall on building that many message
// components. The full transcript is still cached; only the returned slice is
// capped. The renderer raises `limit` to page in older history; live appends
// extend it from there.
const DESKTOP_READ_WINDOW = 300

function windowTranscript(result: ReadTranscriptResult, limit: number): ReadTranscriptResult {
  if (!('messages' in result) || result.messages.length <= limit) {
    return result
  }
  return { ...result, messages: result.messages.slice(-limit) }
}

async function readSession(args: NativeChatReadSessionArgs): Promise<ReadTranscriptResult> {
  const { agent, sessionId } = args
  // Clamp to a positive window; default to the desktop window for the first page.
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  // Desktop is full-class: window by count only, no char truncation.
  const result = await readNativeChatTranscriptCached(agent, sessionId, args.transcriptPath)
  return windowTranscript(result, limit)
}

export type NativeChatSubscribeArgs = {
  /** Renderer-minted id, unique per webContents, echoed back on every emit so
   *  the renderer can route appends to the right hook instance. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
}

export type NativeChatAppendedPayload = {
  subscriptionId: string
  messages: NativeChatMessage[]
}

type LiveSubscription = {
  subscription: NativeChatTranscriptSubscription
}

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
  liveSubscriptions.delete(senderId)
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  // Strict teardown: a closed/reloaded window releases every watcher it owns.
  sender.once('destroyed', () => teardownAllForSender(sender.id))
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
  // Replace any prior subscription under the same id (session change/resubscribe).
  const pendingToken = beginPendingSubscription(sender.id, subscriptionId)
  registerSenderCleanup(sender)

  let subscription: NativeChatTranscriptSubscription
  try {
    subscription = await subscribeNativeChatTranscript({
      agent,
      sessionId,
      transcriptPath,
      onAppend: (messages) => {
        if (sender.isDestroyed()) {
          return
        }
        const payload: NativeChatAppendedPayload = { subscriptionId, messages }
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
}
