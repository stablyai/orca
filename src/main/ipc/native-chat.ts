import { DESKTOP_READ_WINDOW } from '../native-chat/transcript-watch-contract'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { clearNativeChatTranscriptCache } from '../native-chat/transcript-read-cache'
import type { ReadTranscriptResult } from '../native-chat/transcript-reader'
import {
  subscribeNativeChatTranscript,
  readNativeChatTranscriptTail,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../native-chat/transcript-watch'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { agentHookServer } from '../agent-hooks/server'
import { nativeChatTranscriptPathOnExecutionHost } from '../native-chat/ssh-transcript-path'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export { clearNativeChatTranscriptCache }

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** Recent-turn window; increase it to page backward. */
  limit?: number
  /** Hook-authoritative path when session IDs no longer identify transcript filenames. */
  transcriptPath?: string
}

// Bound parsing and rendering to the recent window; pagination raises the limit.

async function readSession(args: NativeChatReadSessionArgs): Promise<ReadTranscriptResult> {
  const { agent, sessionId } = args
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  return readNativeChatTranscriptTail({
    agent,
    sessionId,
    transcriptPath: nativeChatTranscriptPathOnExecutionHost(
      agentHookServer.getStatusSnapshot(),
      sessionId,
      args.transcriptPath
    ),
    limit
  })
}

export type NativeChatSubscribeArgs = {
  /** Renderer ID unique within WebContents, echoed on updates to route each viewer. */
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
        /** The current window has no transcript yet; do not treat it as settled history. */
        pending?: boolean
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

type PendingSubscription = {
  controller: AbortController
}

// A renderer document owns its viewers; replacement, crash, or destruction releases them.
const liveSubscriptions = new Map<number, Map<string, LiveSubscription>>()
// Retire pending setup on unsubscribe/destruction before it can publish a late watcher.
const pendingSubscriptions = new Map<number, Map<string, PendingSubscription>>()
const senderLifetimes = new Map<number, ReturnType<typeof abortWhenRendererGone>>()

function teardownSubscription(senderId: number, subscriptionId: string): void {
  const pendingBySubId = pendingSubscriptions.get(senderId)
  pendingBySubId?.get(subscriptionId)?.controller.abort()
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
  const lifetime = senderLifetimes.get(senderId)
  senderLifetimes.delete(senderId)
  lifetime?.dispose()
  for (const pending of pendingSubscriptions.get(senderId)?.values() ?? []) {
    pending.controller.abort()
  }
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

function registerSenderCleanup(sender: WebContents): AbortSignal {
  const existing = senderLifetimes.get(sender.id)
  if (existing) {
    return existing.signal
  }
  const lifetime = abortWhenRendererGone(sender)
  const onRendererGone = (): void => teardownAllForSender(sender.id)
  senderLifetimes.set(sender.id, {
    signal: lifetime.signal,
    dispose: () => {
      lifetime.signal.removeEventListener('abort', onRendererGone)
      lifetime.dispose()
    }
  })
  lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
  return lifetime.signal
}

function beginPendingSubscription(senderId: number, subscriptionId: string): PendingSubscription {
  teardownSubscription(senderId, subscriptionId)
  const pending = { controller: new AbortController() }
  const bySubId = pendingSubscriptions.get(senderId) ?? new Map<string, PendingSubscription>()
  bySubId.set(subscriptionId, pending)
  pendingSubscriptions.set(senderId, bySubId)
  return pending
}

function takePendingSubscription(
  senderId: number,
  subscriptionId: string,
  pending: PendingSubscription
): boolean {
  const bySubId = pendingSubscriptions.get(senderId)
  if (bySubId?.get(subscriptionId) !== pending) {
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
  const pending = beginPendingSubscription(sender.id, subscriptionId)
  const rendererSignal = registerSenderCleanup(sender)
  const canPublish = (): boolean =>
    !sender.isDestroyed() && !rendererSignal.aborted && !pending.controller.signal.aborted

  const subscribeArgs: SubscribeNativeChatTranscriptArgs = {
    agent,
    sessionId,
    transcriptPath: nativeChatTranscriptPathOnExecutionHost(
      agentHookServer.getStatusSnapshot(),
      sessionId,
      transcriptPath
    ),
    initialLimit: limit,
    onTranscriptPending: () => {
      if (!canPublish()) {
        return
      }
      // Legacy clients ignore pending but still stop spinning on the empty snapshot.
      const payload: NativeChatAppendedPayload = {
        subscriptionId,
        frame: { type: 'snapshot', messages: [], hasMore: false, pending: true }
      }
      sender.send('nativeChat:appended', payload)
    },
    onInitialSnapshot: (messages, hasMore, _beforeOffset, error, lifecycle) => {
      if (!canPublish()) {
        return
      }
      // Put initial drain errors on the first frame so clients cannot remain stuck loading.
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
      if (!canPublish()) {
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
      if (!canPublish()) {
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
  }
  let subscription: NativeChatTranscriptSubscription
  try {
    subscription = await subscribeNativeChatTranscript(subscribeArgs, pending.controller.signal)
  } catch {
    takePendingSubscription(sender.id, subscriptionId, pending)
    return
  }

  // Publish only the generation still owning this subscription after async path resolution.
  const stillCurrent = takePendingSubscription(sender.id, subscriptionId, pending)
  if (!canPublish() || !stillCurrent) {
    subscription.unsubscribe()
    return
  }
  const bySubId = liveSubscriptions.get(sender.id) ?? new Map<string, LiveSubscription>()
  const existing = bySubId.get(subscriptionId)
  if (existing) {
    existing.subscription.unsubscribe()
  }
  bySubId.set(subscriptionId, { subscription })
  liveSubscriptions.set(sender.id, bySubId)
  if (!subscription.watching && canPublish()) {
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

/** Test-only: drop all live and pending transcript subscriptions between runs. */
export function clearNativeChatSubscriptions(): void {
  const senderIds = new Set([
    ...senderLifetimes.keys(),
    ...liveSubscriptions.keys(),
    ...pendingSubscriptions.keys()
  ])
  for (const senderId of senderIds) {
    teardownAllForSender(senderId)
  }
  pendingSubscriptions.clear()
}

export function _getNativeChatSenderCleanupCountForTest(): number {
  return senderLifetimes.size
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
  // Failure output is local-only because paired hosts do not transmit agent output.
  ipcMain.handle('nativeChat:conversationNameFailureOutput', (_event, sessionId: unknown) => {
    const naming = getStructuredAgentSessionHost()?.deps.conversationNaming
    return typeof sessionId === 'string' ? (naming?.failureOutput(sessionId) ?? null) : null
  })
}
