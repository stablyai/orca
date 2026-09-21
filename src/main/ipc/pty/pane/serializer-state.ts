import type { WebContents } from 'electron'
import { RendererTerminalSerializerReadiness } from '../../renderer-terminal-serializer-readiness'
import { isValidPaneKey, paneKeyPtyId } from './key-state'

// Why: renderer pre-declares serializer ownership before pty:spawn to suppress the daemon-snapshot seed; gen tokens prevent paneKey-reuse races on teardown. See docs/mobile-prefer-renderer-scrollback.md.
export let pendingSerializerGenSeq = 0
export const pendingByPaneKey = new Map<
  string,
  { gen: number; ownerWebContentsId: number | null }
>()
export const pendingPaneSerializerCleanupRegistered = new Set<number>()
// Why: bind the declaration generation directly to its spawn result. PTY ids
// are reusable and teardown callbacks carry no incarnation token, so teardown
// must never guess which pending renderer generation it owns.
export const pendingPtyIdBySerializerGeneration = new Map<number, string>()
// Why: hasRendererSerializer probe needs a ptyId-keyed signal; a later spawn starts a fresh incarnation, subscription abort owns waiter cleanup.
export const rendererSerializerReadiness = new RendererTerminalSerializerReadiness()

export function cleanupPendingPaneSerializersForSender(ownerWebContentsId: number): void {
  pendingPaneSerializerCleanupRegistered.delete(ownerWebContentsId)
  for (const [paneKey, pending] of pendingByPaneKey) {
    if (pending.ownerWebContentsId === ownerWebContentsId) {
      pendingByPaneKey.delete(paneKey)
      pendingPtyIdBySerializerGeneration.delete(pending.gen)
    }
  }
}

export function registerPendingPaneSerializerCleanup(sender: WebContents | undefined): void {
  if (!sender || pendingPaneSerializerCleanupRegistered.has(sender.id)) {
    return
  }
  pendingPaneSerializerCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => cleanupPendingPaneSerializersForSender(sender.id))
}

export function declarePendingPaneSerializer(
  paneKey: string,
  sender: WebContents | undefined
): number {
  const gen = ++pendingSerializerGenSeq
  // Why: a sender destroyed before the declaration never fires 'destroyed' again,
  // so its entry would strand in pendingByPaneKey and suppress the daemon seed forever.
  if (sender?.isDestroyed()) {
    cleanupPendingPaneSerializersForSender(sender.id)
    return gen
  }
  registerPendingPaneSerializerCleanup(sender)
  const replaced = pendingByPaneKey.get(paneKey)
  if (replaced) {
    pendingPtyIdBySerializerGeneration.delete(replaced.gen)
  }
  pendingByPaneKey.set(paneKey, { gen, ownerWebContentsId: sender?.id ?? null })
  const existingPtyId = paneKeyPtyId.get(paneKey)
  if (existingPtyId) {
    pendingPtyIdBySerializerGeneration.set(gen, existingPtyId)
  }
  return gen
}

export function settlePendingPaneSerializer(paneKey: string, gen: number): boolean {
  if (pendingByPaneKey.get(paneKey)?.gen !== gen) {
    return false
  }
  pendingByPaneKey.delete(paneKey)
  return true
}

export function hasPendingRendererSerializerForPaneKey(paneKey: string): boolean {
  return isValidPaneKey(paneKey) && pendingByPaneKey.has(paneKey)
}
