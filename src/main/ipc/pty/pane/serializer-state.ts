import type { WebContents } from 'electron'
import { RendererTerminalSerializerReadiness } from '../../renderer-terminal-serializer-readiness'
import { isValidPaneKey, paneKeyPtyId } from './key-state'

// Predeclare renderer serialization before spawn to suppress daemon seeding; generations fence pane-key reuse.
export let pendingSerializerGenSeq = 0
export const pendingByPaneKey = new Map<
  string,
  { gen: number; ownerWebContentsId: number | null }
>()
export const pendingPaneSerializerCleanupRegistered = new Set<number>()
// Bind declaration generation to its spawn result; reusable PTY IDs cannot identify teardown ownership.
export const pendingPtyIdBySerializerGeneration = new Map<number, string>()
// Readiness probes use exact PTY IDs; new spawns reset readiness and subscription abort cleans waiters.
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
  // Already-destroyed senders will never fire destroyed again; remove their declarations immediately.
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
