import { parsePaneKey } from '../../../../shared/stable-pane-id'

// Retain spawn-time pane keys so teardown can release agent-hook caches.
export const ptyPaneKey = new Map<string, string>()
// External pane-key consumers need reverse PTY lookup; update both maps together.
export const paneKeyPtyId = new Map<string, string>()

export function getPtyIdForPaneKey(paneKey: string): string | undefined {
  return paneKeyPtyId.get(paneKey)
}

// Teardown listeners release pane-key timers without a direct dependency on each consumer.
export type PaneKeyTeardownListener = (paneKey: string) => void
export const paneKeyTeardownListeners = new Set<PaneKeyTeardownListener>()

export function registerPaneKeyTeardownListener(listener: PaneKeyTeardownListener): () => void {
  paneKeyTeardownListeners.add(listener)
  return () => paneKeyTeardownListeners.delete(listener)
}

export function parseValidPaneKey(paneKey: unknown): ReturnType<typeof parsePaneKey> {
  if (typeof paneKey !== 'string' || paneKey.length > 256) {
    return null
  }
  return parsePaneKey(paneKey)
}

export function isValidPaneKey(paneKey: unknown): paneKey is string {
  return parseValidPaneKey(paneKey) !== null
}

export function normalizeValidPaneKey(paneKey: unknown): string | null {
  const normalizedPaneKey = typeof paneKey === 'string' ? paneKey.trim() : ''
  return isValidPaneKey(normalizedPaneKey) ? normalizedPaneKey : null
}

export function rememberPaneKeyForPty(ptyId: string, paneKey: unknown): string | null {
  const normalizedPaneKey = normalizeValidPaneKey(paneKey)
  if (normalizedPaneKey === null) {
    return null
  }
  // Re-registering a PTY must remove stale reverse lookup for its previous pane key.
  const previousPaneKey = ptyPaneKey.get(ptyId)
  if (previousPaneKey && previousPaneKey !== normalizedPaneKey) {
    if (paneKeyPtyId.get(previousPaneKey) === ptyId) {
      paneKeyPtyId.delete(previousPaneKey)
    }
  }
  ptyPaneKey.set(ptyId, normalizedPaneKey)
  paneKeyPtyId.set(normalizedPaneKey, ptyId)
  return normalizedPaneKey
}
