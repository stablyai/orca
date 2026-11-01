import type { IpcMainEvent, WebContents } from 'electron'
import { DESKTOP_READ_WINDOW } from '../native-chat/transcript-watch-contract'
import {
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../native-chat/transcript-watch'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { openNativeChatTranscript } from '../native-chat/native-chat-open-wake'
import { publishTranscriptTaskList } from '../native-chat/native-chat-transcript-task-scan'
import type { NativeChatAppendedPayload, NativeChatSubscribeArgs } from './native-chat'

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

export function teardownSubscription(senderId: number, subscriptionId: string): void {
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

export async function handleSubscribe(
  event: IpcMainEvent,
  args: NativeChatSubscribeArgs
): Promise<void> {
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

  // Only the user's open may start the distro; the watch that follows stays background.
  const opened = openNativeChatTranscript(sessionId, transcriptPath, args.wakeWslDistro === true)
  const publishTasks = (): void => {
    if (args.capabilities?.taskList !== 1) {
      return
    }
    publishTranscriptTaskList({
      agent,
      sessionId,
      filePath: opened.transcriptPath,
      stillCurrent: canPublish,
      emit: (taskList) => {
        sender.send('nativeChat:appended', {
          subscriptionId,
          frame: { type: 'task-list', taskList }
        })
      }
    })
  }
  const subscribeArgs: SubscribeNativeChatTranscriptArgs = {
    agent,
    sessionId,
    transcriptPath: opened.transcriptPath,
    initialLimit: limit,
    sourceOrder: true,
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
      if (!error) {
        publishTasks()
      }
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
      publishTasks()
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
    if (opened.waking) {
      await opened.waking
    }
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
