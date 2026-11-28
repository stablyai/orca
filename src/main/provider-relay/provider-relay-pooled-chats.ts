import type { ProviderRelayOpenWork } from './provider-relay-attached-agents'

/** A chat whose agent is one part of a shared relayed agent (a pooled app-server's thread). */
export type PooledProviderRelayChat = {
  /** Its part kept running from before this app started. */
  reattached: () => boolean
  /** Quit may hand its part to the daemon instead of ending it. */
  keepable: () => boolean
  /** Hands its part to the daemon at quit, ending nothing; false when it couldn't. */
  detachForQuit: (open: ProviderRelayOpenWork | null) => Promise<boolean>
}

/** By chat; one entry per pooled chat open in this app. */
const pooled = new Map<string, PooledProviderRelayChat>()
const quitListeners = new Set<() => void>()
/** Hand-offs and stops quit started that the daemon must hear before the app disconnects. */
const quitWork = new Set<Promise<unknown>>()

/** Returns its unregister; a later registration for the chat replaces it. */
export function registerPooledProviderRelayChat(
  chatKey: string,
  chat: PooledProviderRelayChat
): () => void {
  pooled.set(chatKey, chat)
  return () => {
    if (pooled.get(chatKey) === chat) {
      pooled.delete(chatKey)
    }
  }
}

export function pooledProviderRelayChat(chatKey: string): PooledProviderRelayChat | undefined {
  return pooled.get(chatKey)
}

/** Quit waits only when a chat here can be handed off (scanned once, at quit). */
export function pooledProviderRelayChatsPresent(): boolean {
  return quitWork.size > 0 || [...pooled.values()].some((chat) => chat.keepable())
}

/** Runs once quit begins, before chats are evicted. */
export function onProviderRelayQuit(listener: () => void): () => void {
  quitListeners.add(listener)
  return () => quitListeners.delete(listener)
}

export function runProviderRelayQuitListeners(): void {
  for (const listener of quitListeners) {
    listener()
  }
}

export function trackProviderRelayQuitWork(work: Promise<unknown>): void {
  const settled = work.then(
    () => {},
    () => {}
  )
  quitWork.add(settled)
  void settled.then(() => quitWork.delete(settled))
}

/** Settles once every tracked quit hand-off settled, including ones added while waiting. */
export async function providerRelayQuitWorkSettled(): Promise<void> {
  while (quitWork.size > 0) {
    await Promise.all(quitWork)
  }
}
