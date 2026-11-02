import AsyncStorage from '@react-native-async-storage/async-storage'
import { NATIVE_CHAT_TEXT_SCALE_STORAGE_KEY } from '../../../mobile-web-shell/page-storage-keys'
import { quantizeFontScale } from './mobile-native-chat-message-text'

export const NATIVE_CHAT_TEXT_SCALE_KEY = NATIVE_CHAT_TEXT_SCALE_STORAGE_KEY

// Leaving chat unmounts the view, so the pinched size has to outlive that screen.
let remembered = 1
let pinchCommitted = false
let generation = 0
const listeners = new Set<(scale: number) => void>()

// SAFETY: the page bundle's storage adds a sync read and a listener; the native module does not.
const pageStorage = AsyncStorage as typeof AsyncStorage & {
  getItemSync?: (key: string) => string | null | undefined
  subscribePageStorage?: (key: string, listener: (value: string | null) => void) => () => void
}

function notify(): void {
  for (const listener of listeners) {
    listener(remembered)
  }
}

function rememberParsed(raw: string | null, announce: boolean): void {
  const parsed = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed)) {
    return
  }
  const next = quantizeFontScale(parsed)
  if (next === remembered) {
    return
  }
  remembered = next
  generation += 1
  if (announce) {
    notify()
  }
}

export function readRememberedNativeChatTextScale(): number {
  return remembered
}

export function subscribeNativeChatTextScale(listener: (scale: number) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The scale the first render can paint. `ready` is false only while the page cache is unpublished. */
export function readInitialNativeChatTextScale(): { scale: number; ready: boolean } {
  if (typeof pageStorage.getItemSync !== 'function') {
    return { scale: remembered, ready: true }
  }
  const raw = pageStorage.getItemSync(NATIVE_CHAT_TEXT_SCALE_KEY)
  if (raw === undefined) {
    return { scale: remembered, ready: false }
  }
  rememberParsed(raw, false)
  return { scale: remembered, ready: true }
}

export function commitNativeChatTextScale(scale: number): void {
  const next = quantizeFontScale(scale)
  pinchCommitted = true
  if (next === remembered) {
    return
  }
  remembered = next
  generation += 1
  notify()
  void AsyncStorage.setItem(NATIVE_CHAT_TEXT_SCALE_KEY, String(next)).catch(() => {})
}

export async function hydrateNativeChatTextScale(): Promise<number> {
  if (pinchCommitted) {
    return remembered
  }
  const started = generation
  try {
    const raw = await AsyncStorage.getItem(NATIVE_CHAT_TEXT_SCALE_KEY)
    if (pinchCommitted || generation !== started) {
      return remembered
    }
    rememberParsed(raw, true)
    return remembered
  } catch {
    return remembered
  }
}

// Another open page writes the same key; this document has to follow it.
if (typeof pageStorage.subscribePageStorage === 'function') {
  pageStorage.subscribePageStorage(NATIVE_CHAT_TEXT_SCALE_KEY, (raw) => {
    rememberParsed(raw, true)
  })
}
