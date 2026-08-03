import { ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import type { Store } from '../persistence'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../../shared/local-log-tail-types'
import { readLocalLogTailRange } from '../ai-vault/local-log-tail-reader'
import { resolveAuthorizedPath } from './filesystem-auth'

type TailWatch = {
  senderId: number
  watcher: FSWatcher
}

const tailWatches = new Map<string, TailWatch>()
const senderCleanupRegistered = new Set<number>()

function watchKey(senderId: number, subscriptionId: string): string {
  return `${senderId}:${subscriptionId}`
}

function closeWatch(key: string): void {
  const subscription = tailWatches.get(key)
  if (!subscription) {
    return
  }
  tailWatches.delete(key)
  subscription.watcher.close()
}

function closeSenderWatches(senderId: number): void {
  senderCleanupRegistered.delete(senderId)
  for (const [key, subscription] of tailWatches) {
    if (subscription.senderId === senderId) {
      closeWatch(key)
    }
  }
}

function validateSubscriptionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('Invalid local log tail subscription id')
  }
  return value
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => closeSenderWatches(sender.id))
}

export function registerLocalLogTailHandlers(store: Store): void {
  ipcMain.handle(
    'fs:readLocalLogTail',
    async (_event, args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      return readLocalLogTailRange(filePath, args.fromByteOffset, args.expectedIdentity)
    }
  )

  ipcMain.handle(
    'fs:startLocalLogTail',
    async (event, args: LocalLogTailWatchArgs): Promise<void> => {
      const subscriptionId = validateSubscriptionId(args.subscriptionId)
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const key = watchKey(event.sender.id, subscriptionId)
      closeWatch(key)

      const sendChange = (eventType: 'change' | 'rename'): void => {
        if (!tailWatches.has(key) || event.sender.isDestroyed()) {
          return
        }
        const payload: LocalLogTailChangedPayload = { subscriptionId, eventType }
        event.sender.send('fs:localLogTailChanged', payload)
      }
      const watcher = watch(filePath, (eventType) => sendChange(eventType))
      watcher.on('error', () => {
        // Why: an error commonly accompanies rotation. Signal one final drain so
        // the renderer can detect identity change, then release the dead handle.
        sendChange('rename')
        closeWatch(key)
      })
      tailWatches.set(key, { senderId: event.sender.id, watcher })
      registerSenderCleanup(event.sender)
    }
  )

  ipcMain.handle('fs:stopLocalLogTail', (event, args: { subscriptionId: string }): void => {
    closeWatch(watchKey(event.sender.id, validateSubscriptionId(args.subscriptionId)))
  })
}

export function closeAllLocalLogTailWatchers(): void {
  for (const key of Array.from(tailWatches.keys())) {
    closeWatch(key)
  }
  senderCleanupRegistered.clear()
}

/** Test-only: verifies tab/window teardown does not retain native watchers. */
export function getActiveLocalLogTailWatcherCount(): number {
  return tailWatches.size
}
