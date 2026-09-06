import { ipcMain, type IpcMainEvent } from 'electron'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../shared/agent-session-context'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import { clearNativeChatTranscriptCache } from '../native-chat/transcript-read-cache'
import {
  subscribeNativeChatTranscript,
  type SubscribeNativeChatTranscriptArgs
} from '../native-chat/transcript-watch'
import type { NativeChatTranscriptSubscription } from '../native-chat/transcript-watch-contract'
import {
  agentSessionContextUsageEqual,
  readNativeChatSessionContext
} from '../native-chat/session-context-reader'
import {
  DESKTOP_NATIVE_CHAT_READ_WINDOW,
  readNativeChatSession,
  type NativeChatReadSessionArgs
} from './native-chat-session-read'
import {
  beginPendingNativeChatSubscription,
  clearNativeChatSubscriptions,
  getNativeChatPendingSubscriptionCountForTest,
  getNativeChatSenderCleanupCountForTest,
  liveNativeChatSubscriptions,
  registerNativeChatSenderCleanup,
  takePendingNativeChatSubscription,
  teardownNativeChatSubscription
} from './native-chat-subscription-registry'

export type { NativeChatReadSessionArgs } from './native-chat-session-read'

// Re-export so existing test imports of `clearNativeChatTranscriptCache` from
// this module keep working after the cache moved to transcript-read-cache.ts.
export { clearNativeChatTranscriptCache }

export type NativeChatSubscribeArgs = {
  /** Renderer-minted id, unique per webContents, echoed back on every emit so
   *  the renderer can route appends to the right hook instance. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  paneKey?: string
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
        /** No transcript exists behind this window yet — render it, but do not
         *  treat it as a settled read of the session's history. */
        pending?: boolean
        context?: AgentSessionContextSnapshot
      }
    | {
        type: 'replacement'
        messages: NativeChatMessage[]
        hasMore: boolean
        lifecycle?: NativeChatTurnLifecycle
        context?: AgentSessionContextSnapshot
      }
    | {
        type: 'appended'
        messages: NativeChatMessage[]
        lifecycle?: NativeChatTurnLifecycle
        context?: AgentSessionContextSnapshot
      }
}

async function handleSubscribe(event: IpcMainEvent, args: NativeChatSubscribeArgs): Promise<void> {
  const sender = event.sender
  if (sender.isDestroyed()) {
    return
  }
  const { subscriptionId, agent, sessionId, transcriptPath, paneKey } = args
  const limit =
    args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_NATIVE_CHAT_READ_WINDOW
  // Replace any prior subscription under the same id (session change/resubscribe).
  const pending = beginPendingNativeChatSubscription(sender.id, subscriptionId)
  registerNativeChatSenderCleanup(sender)

  let context = EMPTY_AGENT_SESSION_CONTEXT
  const contextReady = readNativeChatSessionContext({
    agent,
    sessionId,
    transcriptPath,
    paneKey
  }).then((next) => {
    context = next
  })
  const refreshContext = async (): Promise<void> => {
    const next = await readNativeChatSessionContext({
      agent,
      sessionId,
      transcriptPath,
      paneKey,
      current: context
    })
    if (sender.isDestroyed() || agentSessionContextUsageEqual(context, next)) {
      return
    }
    context = next
    sender.send('nativeChat:appended', {
      subscriptionId,
      frame: {
        type: 'appended',
        messages: [],
        ...(context.source === 'unavailable' ? {} : { context })
      }
    } satisfies NativeChatAppendedPayload)
  }
  let contextRefresh = Promise.resolve()
  const scheduleContextRefresh = (): void => {
    contextRefresh = contextRefresh.then(refreshContext).catch(() => undefined)
  }

  const subscribeArgs: SubscribeNativeChatTranscriptArgs = {
    agent,
    sessionId,
    transcriptPath,
    initialLimit: limit,
    onTranscriptPending: () => {
      if (sender.isDestroyed()) {
        return
      }
      // `pending` marks a window with no transcript behind it yet; clients that
      // don't know the flag still stop spinning on the empty snapshot.
      const payload: NativeChatAppendedPayload = {
        subscriptionId,
        frame: { type: 'snapshot', messages: [], hasMore: false, pending: true }
      }
      sender.send('nativeChat:appended', payload)
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
          ...(lifecycle ? { lifecycle } : {}),
          ...(context.source === 'unavailable' ? {} : { context })
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
          ...(lifecycle ? { lifecycle } : {}),
          ...(context.source === 'unavailable' ? {} : { context })
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
          ...(lifecycle ? { lifecycle } : {}),
          ...(context.source === 'unavailable' ? {} : { context })
        }
      }
      sender.send('nativeChat:appended', payload)
      scheduleContextRefresh()
    },
    onOpaqueAppend: scheduleContextRefresh
  }
  let subscription: NativeChatTranscriptSubscription
  try {
    subscription = await subscribeNativeChatTranscript(subscribeArgs, pending.controller.signal)
    await contextReady
  } catch {
    takePendingNativeChatSubscription(sender.id, subscriptionId, pending)
    return
  }

  // Why: unmount, destruction, or a newer same-id subscribe can invalidate setup
  // while path resolution is pending; only the owning generation may publish its watcher.
  const stillCurrent = takePendingNativeChatSubscription(sender.id, subscriptionId, pending)
  if (sender.isDestroyed() || !stillCurrent) {
    subscription.unsubscribe()
    return
  }
  const bySubId = liveNativeChatSubscriptions.get(sender.id) ?? new Map()
  // A concurrent subscribe with the same id beat us here; honor the latest.
  const existing = bySubId.get(subscriptionId)
  if (existing) {
    existing.subscription.unsubscribe()
  }
  bySubId.set(subscriptionId, { subscription })
  liveNativeChatSubscriptions.set(sender.id, bySubId)
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

export { clearNativeChatSubscriptions }
export const _getNativeChatSenderCleanupCountForTest = getNativeChatSenderCleanupCountForTest
export const _getNativeChatPendingSubscriptionCountForTest =
  getNativeChatPendingSubscriptionCountForTest

export function registerNativeChatHandlers(): void {
  ipcMain.handle('nativeChat:readSession', (_event, args: NativeChatReadSessionArgs) =>
    readNativeChatSession(args)
  )
  ipcMain.on('nativeChat:subscribe', (event, args: NativeChatSubscribeArgs) => {
    void handleSubscribe(event, args)
  })
  ipcMain.on('nativeChat:unsubscribe', (event, args: { subscriptionId: string }) => {
    teardownNativeChatSubscription(event.sender.id, args.subscriptionId)
  })
}
