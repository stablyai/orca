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
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import {
  LocalLogTailOperationAdmission,
  MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER,
  MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE
} from './local-log-tail-operation-admission'

type TailWatch = {
  generation: symbol
  senderId: number
  watcher: FSWatcher
}

const tailWatches = new Map<string, TailWatch>()
const watchGenerations = new Map<string, { generation: symbol; senderId: number }>()
const senderCleanups = new Map<number, { sender: WebContents; onDestroyed: () => void }>()
const operationAdmission = new LocalLogTailOperationAdmission()

export const MAX_LOCAL_LOG_TAIL_SUBSCRIPTION_ID_BYTES = 1_024
export const MAX_LOCAL_LOG_TAIL_PATH_BYTES = 64 * 1_024
export const MAX_LOCAL_LOG_TAIL_FILE_IDENTITY_BYTES = 1_024

function watchKey(senderId: number, subscriptionId: string): string {
  return `${senderId}:${subscriptionId}`
}

function closeWatchHandle(key: string, generation?: symbol): number | undefined {
  const subscription = tailWatches.get(key)
  if (!subscription || (generation !== undefined && subscription.generation !== generation)) {
    return undefined
  }
  tailWatches.delete(key)
  subscription.watcher.close()
  releaseSenderCleanupIfIdle(subscription.senderId)
  return subscription.senderId
}

function closeWatch(key: string): void {
  const owner = watchGenerations.get(key)
  watchGenerations.delete(key)
  const senderId = closeWatchHandle(key) ?? owner?.senderId
  if (senderId !== undefined) {
    releaseSenderCleanupIfIdle(senderId)
  }
}

function closeWatchGeneration(key: string, generation: symbol): void {
  const owner = watchGenerations.get(key)
  if (owner?.generation === generation) {
    watchGenerations.delete(key)
  }
  const senderId = closeWatchHandle(key, generation) ?? owner?.senderId
  if (senderId !== undefined) {
    releaseSenderCleanupIfIdle(senderId)
  }
}

function closeSenderWatches(senderId: number): void {
  releaseSenderCleanup(senderId)
  for (const [key, owner] of watchGenerations) {
    if (owner.senderId === senderId) {
      closeWatch(key)
    }
  }
}

function validateSubscriptionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    measureUtf8ByteLength(value, {
      stopAfterBytes: MAX_LOCAL_LOG_TAIL_SUBSCRIPTION_ID_BYTES
    }).exceededLimit
  ) {
    throw new Error('Invalid local log tail subscription id')
  }
  return value
}

function validateFilePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    measureUtf8ByteLength(value, { stopAfterBytes: MAX_LOCAL_LOG_TAIL_PATH_BYTES }).exceededLimit
  ) {
    throw new Error('Invalid local log tail path')
  }
  return value
}

function validateExpectedIdentity(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    typeof value !== 'string' ||
    measureUtf8ByteLength(value, {
      stopAfterBytes: MAX_LOCAL_LOG_TAIL_FILE_IDENTITY_BYTES
    }).exceededLimit
  ) {
    throw new Error('Invalid local log tail file identity')
  }
  return value
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanups.has(sender.id)) {
    return
  }
  const onDestroyed = (): void => closeSenderWatches(sender.id)
  senderCleanups.set(sender.id, { sender, onDestroyed })
  sender.once('destroyed', onDestroyed)
}

function releaseSenderCleanup(senderId: number): void {
  const cleanup = senderCleanups.get(senderId)
  if (!cleanup) {
    return
  }
  senderCleanups.delete(senderId)
  cleanup.sender.removeListener('destroyed', cleanup.onDestroyed)
}

function releaseSenderCleanupIfIdle(senderId: number): void {
  for (const owner of watchGenerations.values()) {
    if (owner.senderId === senderId) {
      return
    }
  }
  for (const subscription of tailWatches.values()) {
    if (subscription.senderId === senderId) {
      return
    }
  }
  releaseSenderCleanup(senderId)
}

function activeSenderWatchCount(senderId: number): number {
  let count = 0
  for (const subscription of tailWatches.values()) {
    if (subscription.senderId === senderId) {
      count += 1
    }
  }
  return count
}

function restorePreviousWatchGeneration(
  key: string,
  generation: symbol,
  previousGeneration: symbol | undefined,
  senderId: number
): void {
  if (watchGenerations.get(key)?.generation !== generation) {
    return
  }
  const previousWatch = tailWatches.get(key)
  if (previousGeneration !== undefined && previousWatch?.generation === previousGeneration) {
    watchGenerations.set(key, { generation: previousGeneration, senderId })
  } else {
    watchGenerations.delete(key)
  }
}

function validateByteOffset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid local log tail byte offset')
  }
  return value as number
}

export function registerLocalLogTailHandlers(store: Store): void {
  ipcMain.handle(
    'fs:readLocalLogTail',
    async (event, args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> => {
      const senderId = event.sender.id
      const requestedPath = validateFilePath(args.filePath)
      const fromByteOffset = validateByteOffset(args.fromByteOffset)
      const expectedIdentity = validateExpectedIdentity(args.expectedIdentity)
      const readToken = operationAdmission.claimRead(senderId)
      try {
        const filePath = await resolveAuthorizedPath(requestedPath, store)
        return await readLocalLogTailRange(filePath, fromByteOffset, expectedIdentity)
      } finally {
        operationAdmission.releaseRead(senderId, readToken)
      }
    }
  )

  ipcMain.handle(
    'fs:startLocalLogTail',
    async (event, args: LocalLogTailWatchArgs): Promise<void> => {
      const subscriptionId = validateSubscriptionId(args.subscriptionId)
      const requestedPath = validateFilePath(args.filePath)
      const senderId = event.sender.id
      const key = watchKey(senderId, subscriptionId)
      const pendingToken = operationAdmission.claimStart(senderId)
      const previousGeneration = watchGenerations.get(key)?.generation
      const generation = Symbol(subscriptionId)
      watchGenerations.set(key, { generation, senderId })
      registerSenderCleanup(event.sender)
      let published = false
      try {
        const filePath = await resolveAuthorizedPath(requestedPath, store)
        if (event.sender.isDestroyed() || watchGenerations.get(key)?.generation !== generation) {
          return
        }
        const replacing = tailWatches.has(key)
        if (
          !replacing &&
          (activeSenderWatchCount(senderId) >= MAX_LOCAL_LOG_TAIL_WATCHES_PER_SENDER ||
            tailWatches.size >= MAX_LOCAL_LOG_TAIL_WATCHES_PROCESS_WIDE)
        ) {
          throw new Error('Too many local log tail watchers')
        }
        closeWatchHandle(key)

        const sendChange = (eventType: 'change' | 'rename'): void => {
          if (tailWatches.get(key)?.generation !== generation || event.sender.isDestroyed()) {
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
          closeWatchGeneration(key, generation)
        })
        tailWatches.set(key, { generation, senderId, watcher })
        published = true
        if (event.sender.isDestroyed()) {
          closeWatchGeneration(key, generation)
        }
      } finally {
        if (!published) {
          restorePreviousWatchGeneration(key, generation, previousGeneration, senderId)
          releaseSenderCleanupIfIdle(senderId)
        }
        operationAdmission.releaseStart(senderId, pendingToken)
      }
    }
  )

  ipcMain.handle('fs:stopLocalLogTail', (event, args: { subscriptionId: string }): void => {
    closeWatch(watchKey(event.sender.id, validateSubscriptionId(args.subscriptionId)))
  })
}

export function closeAllLocalLogTailWatchers(): void {
  for (const key of new Set([...watchGenerations.keys(), ...tailWatches.keys()])) {
    closeWatch(key)
  }
  for (const senderId of Array.from(senderCleanups.keys())) {
    releaseSenderCleanup(senderId)
  }
  operationAdmission.reset()
}

/** Test-only: verifies tab/window teardown does not retain native watchers. */
export function getActiveLocalLogTailWatcherCount(): number {
  return tailWatches.size
}

export function getLocalLogTailSenderCleanupCountForTest(): number {
  return senderCleanups.size
}

export function getPendingLocalLogTailStartCountForTest(): number {
  return operationAdmission.pendingStartCount
}

export function getPendingLocalLogTailReadCountForTest(): number {
  return operationAdmission.pendingReadCount
}
