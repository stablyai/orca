import { useCallback, useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  botChatFoldKey,
  normalizeBotChatFolds,
  withBotChatFold,
  type BotChatFold
} from '../../../src/shared/bots/bot-chat-tree'

// The phone's manual chat folds, kept like the desktop's (each client keeps its own) and read by every Activity sheet.
const STORAGE_KEY = 'orca.bots.chatFolds'

let folds: Record<string, BotChatFold> = {}
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function load(): void {
  loading ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      // A fold set before the read landed wins over the stored one.
      folds = { ...normalizeBotChatFolds(raw ? JSON.parse(raw) : {}), ...folds }
      notify()
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  load()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setBotChatFold(
  hostKey: string,
  botId: string,
  chatId: string,
  fold: BotChatFold | null
): void {
  folds = withBotChatFold(folds, botChatFoldKey(hostKey, botId, chatId), fold)
  notify()
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(folds)).catch(() => {})
}

const readFolds = (): Readonly<Record<string, BotChatFold>> => folds

/** Every fold this phone keeps, by `botChatFoldKey`, for the host list's chat rows. */
export function useBotChatFolds(): Readonly<Record<string, BotChatFold>> {
  return useSyncExternalStore(subscribe, readFolds, readFolds)
}

/** The owner's fold for one chat of a bot on this host; undefined when they never set one. */
export function useBotChatFold(
  hostKey: string,
  botId: string,
  chatId: string
): BotChatFold | undefined {
  const getSnapshot = useCallback(
    () => folds[botChatFoldKey(hostKey, botId, chatId)],
    [hostKey, botId, chatId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
