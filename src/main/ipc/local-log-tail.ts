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
import { abortWhenRendererGone } from './renderer-lifetime-abort'

type TailSenderOwner = {
  senderId: number
  pending: Map<string, symbol>
  watchKeys: Set<string>
  signal: AbortSignal
  dispose: () => void
}

type TailWatch = {
  owner: TailSenderOwner
  watcher: FSWatcher
}

const tailWatches = new Map<string, TailWatch>()
const senderOwners = new Map<number, TailSenderOwner>()

function watchKey(senderId: number, subscriptionId: string): string {
  return `${senderId}:${subscriptionId}`
}

function releaseIdleOwner(owner: TailSenderOwner): void {
  if (owner.pending.size > 0 || owner.watchKeys.size > 0) {
    return
  }
  if (senderOwners.get(owner.senderId) === owner) {
    senderOwners.delete(owner.senderId)
  }
  owner.dispose()
}

function closeWatch(key: string, expected?: TailWatch): void {
  const subscription = tailWatches.get(key)
  if (!subscription || (expected && subscription !== expected)) {
    return
  }
  tailWatches.delete(key)
  subscription.owner.watchKeys.delete(key)
  try {
    subscription.watcher.close()
  } finally {
    releaseIdleOwner(subscription.owner)
  }
}

function closeSenderWatches(owner: TailSenderOwner): void {
  owner.pending.clear()
  for (const key of owner.watchKeys) {
    const subscription = tailWatches.get(key)
    if (subscription?.owner === owner) {
      closeWatch(key, subscription)
    }
  }
  releaseIdleOwner(owner)
}

function getSenderOwner(sender: WebContents): TailSenderOwner {
  const existing = senderOwners.get(sender.id)
  if (existing) {
    return existing
  }
  const lifetime = abortWhenRendererGone(sender)
  const onAbort = (): void => closeSenderWatches(owner)
  const owner: TailSenderOwner = {
    senderId: sender.id,
    pending: new Map(),
    watchKeys: new Set(),
    signal: lifetime.signal,
    dispose: () => {
      lifetime.signal.removeEventListener('abort', onAbort)
      lifetime.dispose()
    }
  }
  senderOwners.set(sender.id, owner)
  lifetime.signal.addEventListener('abort', onAbort, { once: true })
  return owner
}

function validateSubscriptionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('Invalid local log tail subscription id')
  }
  return value
}

async function startWatch(
  sender: WebContents,
  args: LocalLogTailWatchArgs,
  store: Store
): Promise<void> {
  const subscriptionId = validateSubscriptionId(args.subscriptionId)
  if (sender.isDestroyed()) {
    return
  }
  const key = watchKey(sender.id, subscriptionId)
  const owner = getSenderOwner(sender)
  const pending = Symbol(subscriptionId)
  owner.pending.set(key, pending)
  try {
    const filePath = await resolveAuthorizedPath(args.filePath, store)
    if (
      sender.isDestroyed() ||
      owner.signal.aborted ||
      senderOwners.get(sender.id) !== owner ||
      owner.pending.get(key) !== pending
    ) {
      return
    }
    closeWatch(key)
    const sendChange = (eventType: 'change' | 'rename'): void => {
      if (tailWatches.get(key) !== subscription || sender.isDestroyed()) {
        return
      }
      const payload: LocalLogTailChangedPayload = { subscriptionId, eventType }
      sender.send('fs:localLogTailChanged', payload)
    }
    const watcher = watch(filePath, (eventType) => sendChange(eventType))
    const subscription: TailWatch = { owner, watcher }
    watcher.on('error', () => {
      // Rotation needs one final drain before releasing this exact watcher.
      sendChange('rename')
      closeWatch(key, subscription)
    })
    tailWatches.set(key, subscription)
    owner.watchKeys.add(key)
  } finally {
    if (owner.pending.get(key) === pending) {
      owner.pending.delete(key)
    }
    releaseIdleOwner(owner)
  }
}

export function registerLocalLogTailHandlers(store: Store): void {
  ipcMain.handle(
    'fs:readLocalLogTail',
    async (_event, args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      return readLocalLogTailRange(filePath, args.fromByteOffset, args.expectedIdentity)
    }
  )

  ipcMain.handle('fs:startLocalLogTail', (event, args: LocalLogTailWatchArgs): Promise<void> =>
    startWatch(event.sender, args, store)
  )

  ipcMain.handle('fs:stopLocalLogTail', (event, args: { subscriptionId: string }): void => {
    const key = watchKey(event.sender.id, validateSubscriptionId(args.subscriptionId))
    const owner = senderOwners.get(event.sender.id)
    owner?.pending.delete(key)
    closeWatch(key)
    if (owner) {
      releaseIdleOwner(owner)
    }
  })
}

export function closeAllLocalLogTailWatchers(): void {
  for (const owner of senderOwners.values()) {
    closeSenderWatches(owner)
  }
}

/** Test-only: verifies tab/window teardown does not retain native watchers. */
export function getActiveLocalLogTailWatcherCount(): number {
  return tailWatches.size
}
