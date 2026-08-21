import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type {
  SideQuestCreateArgs,
  SideQuestCreateResult,
  SideQuestInterruptArgs,
  SideQuestReadArgs,
  SideQuestReadResult,
  SideQuestSendArgs,
  SideQuestSendResult,
  SideQuestStreamEvent,
  SideQuestStreamPayload,
  SideQuestSubscribeArgs
} from '../../shared/side-quest-runtime-types'
import {
  CodexSideQuestManager,
  type CodexSideQuestManagerOptions
} from '../side-quest/codex-side-quest-manager'
import {
  codexSideQuestItemToMessage,
  codexSideQuestThreadMessages,
  codexSideQuestTurnError,
  isCodexSideQuestEmptyThreadReadError
} from '../side-quest/codex-side-quest-native-chat'
import type { CodexAppServerEvent } from '../side-quest/codex-app-server-protocol'

type SideQuestSubscription = {
  sender: WebContents
  subscriptionId: string
  providerThreadId: string
}

const subscriptions = new Map<number, Map<string, SideQuestSubscription>>()
const senderCleanupRegistered = new Set<number>()

function removeSubscription(senderId: number, subscriptionId: string): void {
  const senderSubscriptions = subscriptions.get(senderId)
  senderSubscriptions?.delete(subscriptionId)
  if (senderSubscriptions?.size === 0) {
    subscriptions.delete(senderId)
  }
}

function removeSenderSubscriptions(senderId: number): void {
  subscriptions.delete(senderId)
  senderCleanupRegistered.delete(senderId)
}

function subscribe(event: IpcMainEvent, args: SideQuestSubscribeArgs): void {
  if (event.sender.isDestroyed()) {
    return
  }
  if (!senderCleanupRegistered.has(event.sender.id)) {
    senderCleanupRegistered.add(event.sender.id)
    event.sender.once('destroyed', () => removeSenderSubscriptions(event.sender.id))
  }
  const senderSubscriptions = subscriptions.get(event.sender.id) ?? new Map()
  senderSubscriptions.set(args.subscriptionId, {
    sender: event.sender,
    subscriptionId: args.subscriptionId,
    providerThreadId: args.providerThreadId
  })
  subscriptions.set(event.sender.id, senderSubscriptions)
}

function publish(event: SideQuestStreamEvent): void {
  for (const senderSubscriptions of subscriptions.values()) {
    for (const subscription of senderSubscriptions.values()) {
      if (
        subscription.providerThreadId !== event.providerThreadId ||
        subscription.sender.isDestroyed()
      ) {
        continue
      }
      const payload: SideQuestStreamPayload = {
        subscriptionId: subscription.subscriptionId,
        event
      }
      subscription.sender.send('sideQuest:event', payload)
    }
  }
}

function publishGlobalError(message: string): void {
  for (const senderSubscriptions of subscriptions.values()) {
    for (const subscription of senderSubscriptions.values()) {
      if (subscription.sender.isDestroyed()) {
        continue
      }
      const payload: SideQuestStreamPayload = {
        subscriptionId: subscription.subscriptionId,
        event: {
          type: 'error',
          providerThreadId: subscription.providerThreadId,
          message
        }
      }
      subscription.sender.send('sideQuest:event', payload)
    }
  }
}

function publishManagerEvent(event: CodexAppServerEvent): void {
  if (event.type === 'agent-message-delta') {
    publish({
      type: event.type,
      providerThreadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      delta: event.delta
    })
    return
  }
  if (event.type === 'item-completed') {
    const message = codexSideQuestItemToMessage({
      item: event.item,
      turnId: event.turnId,
      timestamp: event.completedAtMs,
      source: 'hook'
    })
    if (message) {
      publish({
        type: 'message-completed',
        providerThreadId: event.threadId,
        turnId: event.turnId,
        message
      })
    }
    return
  }
  if (event.type === 'turn-completed') {
    publish({
      type: 'turn-completed',
      providerThreadId: event.threadId,
      turnId: event.turn.id,
      status: event.turn.status,
      error: codexSideQuestTurnError(event.turn)
    })
    return
  }
  if (event.threadId) {
    publish({ type: 'error', providerThreadId: event.threadId, message: event.message })
    return
  }
  // Why: protocol/process failures may happen before app-server can attribute
  // them to a thread; every active Side Quest must leave its pending state.
  publishGlobalError(event.message)
}

export function registerSideQuestHandlers(options: CodexSideQuestManagerOptions = {}): () => void {
  const manager = new CodexSideQuestManager(options)
  const unsubscribeManager = manager.subscribe(publishManagerEvent)

  ipcMain.handle(
    'sideQuest:create',
    async (_event, args: SideQuestCreateArgs): Promise<SideQuestCreateResult> => {
      const thread = await manager.startSession({ cwd: args.cwd })
      return { providerThreadId: thread.id }
    }
  )
  ipcMain.handle(
    'sideQuest:read',
    async (_event, args: SideQuestReadArgs): Promise<SideQuestReadResult> => {
      try {
        return {
          messages: codexSideQuestThreadMessages(await manager.readSession(args.providerThreadId))
        }
      } catch (error) {
        // Why: app-server does not materialize a new durable thread until its
        // first turn. Before then, an unavailable includeTurns view means the
        // conversation is empty—not broken.
        if (isCodexSideQuestEmptyThreadReadError(error)) {
          return { messages: [] }
        }
        throw error
      }
    }
  )
  ipcMain.handle(
    'sideQuest:send',
    async (_event, args: SideQuestSendArgs): Promise<SideQuestSendResult> => {
      const turn = await manager.startTurn({
        threadId: args.providerThreadId,
        text: args.text,
        clientUserMessageId: args.clientUserMessageId,
        effort: 'low'
      })
      return { turnId: turn.id }
    }
  )
  ipcMain.handle('sideQuest:interrupt', async (_event, args: SideQuestInterruptArgs) => {
    await manager.interruptTurn(args.providerThreadId, args.turnId)
  })
  ipcMain.on('sideQuest:subscribe', (event, args: SideQuestSubscribeArgs) => subscribe(event, args))
  ipcMain.on('sideQuest:unsubscribe', (event, args: { subscriptionId: string }) =>
    removeSubscription(event.sender.id, args.subscriptionId)
  )

  return () => {
    unsubscribeManager()
    manager.dispose()
    subscriptions.clear()
    senderCleanupRegistered.clear()
  }
}
