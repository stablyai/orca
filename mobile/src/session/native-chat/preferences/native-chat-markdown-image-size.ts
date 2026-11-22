import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import {
  normalizeNativeChatMarkdownImageSize,
  type NativeChatMarkdownImageSize
} from '../../../../../src/shared/native-chat/settings/native-chat-markdown-image-size'
import { persistMirrored, subscribeMirroredKey } from '../../../storage/mirrored-storage-keys'

/** Phone-only. The desktop stores the same choice on its own profile. Both default to column width. */
export const NATIVE_CHAT_MARKDOWN_IMAGE_SIZE_KEY = 'orca:nativeChatMarkdownImageSize'

let snapshot: NativeChatMarkdownImageSize = 'column'
let changeCount = 0
let writes: Promise<void> = Promise.resolve()
let hydrated = false
const listeners = new Set<() => void>()

function adopt(value: unknown): void {
  const next = normalizeNativeChatMarkdownImageSize(value)
  if (snapshot === next) {
    return
  }
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

/** Rereads storage. An in-flight edit wins over an older read. */
export function reloadNativeChatMarkdownImageSize(): Promise<void> {
  const readAt = changeCount
  return Promise.resolve()
    .then(() => AsyncStorage.getItem(NATIVE_CHAT_MARKDOWN_IMAGE_SIZE_KEY))
    .then((raw) => {
      if (changeCount === readAt) {
        adopt(raw)
      }
    })
    .catch(() => undefined)
}

subscribeMirroredKey(NATIVE_CHAT_MARKDOWN_IMAGE_SIZE_KEY, (raw, source) => {
  if (source === 'page') {
    changeCount += 1
    adopt(raw)
  }
})

const hydration = reloadNativeChatMarkdownImageSize().then(() => {
  hydrated = true
})

function persist(value: NativeChatMarkdownImageSize): Promise<void> {
  changeCount += 1
  const change = changeCount
  adopt(value)
  const write = writes.then(() => persistMirrored(NATIVE_CHAT_MARKDOWN_IMAGE_SIZE_KEY, value))
  writes = write.catch(() => {
    if (changeCount === change) {
      void reloadNativeChatMarkdownImageSize()
    }
  })
  return writes
}

export function updateNativeChatMarkdownImageSize(
  value: NativeChatMarkdownImageSize
): Promise<void> {
  return hydrated ? persist(value) : hydration.then(() => persist(value))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useNativeChatMarkdownImageSize(): NativeChatMarkdownImageSize {
  return useSyncExternalStore(subscribe, () => snapshot)
}
