import { ipcMain, type IpcMainEvent } from 'electron'
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
  type NativeChatTranscriptSubscription
} from '../native-chat/transcript-watch'
import {
  NATIVE_CHAT_TRANSCRIPT_PAGE_RESERVATION_BYTES,
  nativeChatTranscriptReadAdmission
} from '../native-chat/transcript-read-admission'
import {
  isValidNativeChatSubscriptionId,
  isValidNativeChatTranscriptRequestStrings,
  NativeChatReadAdmission,
  normalizeNativeChatDesktopReadLimit
} from './native-chat-ipc-admission'
import { NativeChatSubscriptionRegistry } from './native-chat-subscription-registry'

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

const readAdmission = new NativeChatReadAdmission()

async function readSession(
  senderId: number,
  args: NativeChatReadSessionArgs
): Promise<ReadTranscriptResult> {
  if (!args || !isValidNativeChatTranscriptRequestStrings(args)) {
    return { error: 'Invalid native chat transcript request' }
  }
  const readToken = readAdmission.claim(senderId)
  if (!readToken) {
    return { error: 'Too many concurrent native chat transcript reads' }
  }
  const { agent, sessionId, transcriptPath } = args
  const limit = normalizeNativeChatDesktopReadLimit(args.limit)
  let releaseMemory: (() => void) | undefined
  try {
    releaseMemory = await nativeChatTranscriptReadAdmission.acquire(
      NATIVE_CHAT_TRANSCRIPT_PAGE_RESERVATION_BYTES
    )
    return await readNativeChatTranscriptTail({
      agent,
      sessionId,
      transcriptPath,
      limit
    })
  } catch (error) {
    if (!releaseMemory) {
      return {
        error: error instanceof Error ? error.message : 'Native chat transcript reader is busy'
      }
    }
    throw error
  } finally {
    releaseMemory?.()
    readAdmission.release(senderId, readToken)
  }
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

const subscriptionRegistry = new NativeChatSubscriptionRegistry()

async function handleSubscribe(event: IpcMainEvent, args: NativeChatSubscribeArgs): Promise<void> {
  const sender = event.sender
  if (
    sender.isDestroyed() ||
    !args ||
    !isValidNativeChatSubscriptionId(args.subscriptionId) ||
    !isValidNativeChatTranscriptRequestStrings(args) ||
    !subscriptionRegistry.canAdmit(sender.id, args.subscriptionId)
  ) {
    return
  }
  const { subscriptionId, agent, sessionId, transcriptPath } = args
  const setupAttempt = subscriptionRegistry.claimSetup(sender.id)
  if (!setupAttempt) {
    return
  }
  const limit = normalizeNativeChatDesktopReadLimit(args.limit)
  // Replace any prior subscription under the same id (session change/resubscribe).
  const pendingToken = subscriptionRegistry.beginPending(sender.id, subscriptionId)
  subscriptionRegistry.registerSenderCleanup(sender)

  let subscription: NativeChatTranscriptSubscription
  try {
    subscription = await subscribeNativeChatTranscript({
      agent,
      sessionId,
      transcriptPath,
      initialLimit: limit,
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
    subscriptionRegistry.takePending(sender.id, subscriptionId, pendingToken)
    subscriptionRegistry.releaseSenderCleanupIfIdle(sender.id)
    return
  } finally {
    subscriptionRegistry.releaseSetup(sender.id, setupAttempt)
  }

  // Why: unmount, destruction, or a newer same-id subscribe can invalidate setup
  // while path resolution is pending; only the owning token may publish its watcher.
  const stillCurrent = subscriptionRegistry.takePending(sender.id, subscriptionId, pendingToken)
  if (sender.isDestroyed() || !stillCurrent) {
    subscription.unsubscribe()
    return
  }
  subscriptionRegistry.publish(sender.id, subscriptionId, subscription)
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

/** Test-only: drop all live and pending transcript subscriptions between runs. */
export function clearNativeChatSubscriptions(): void {
  subscriptionRegistry.reset()
  readAdmission.reset()
}

export function _getNativeChatSenderCleanupCountForTest(): number {
  return subscriptionRegistry.cleanupCount
}

export function _getNativeChatPendingSubscriptionCountForTest(): number {
  return subscriptionRegistry.pendingCount
}

export function _getNativeChatLiveSubscriptionCountForTest(): number {
  return subscriptionRegistry.logicalSubscriptionCount
}

export function _getNativeChatSetupAttemptCountForTest(): number {
  return subscriptionRegistry.setupAttemptCount
}

export function _getNativeChatReadCountForTest(): number {
  return readAdmission.size
}

export function registerNativeChatHandlers(): void {
  ipcMain.handle('nativeChat:readSession', (event, args: NativeChatReadSessionArgs) =>
    readSession(event.sender.id, args)
  )
  ipcMain.on('nativeChat:subscribe', (event, args: NativeChatSubscribeArgs) => {
    void handleSubscribe(event, args)
  })
  ipcMain.on('nativeChat:unsubscribe', (event, args: { subscriptionId: string }) => {
    if (args && isValidNativeChatSubscriptionId(args.subscriptionId)) {
      subscriptionRegistry.teardown(event.sender.id, args.subscriptionId)
    }
  })
}
