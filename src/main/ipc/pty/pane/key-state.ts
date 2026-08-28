import { parsePaneKey } from '../../../../shared/stable-pane-id'

// Why: track spawn-time paneKey so teardown can clear the agent-hooks server's per-paneKey cache, which otherwise grows unbounded as panes come and go.
export const ptyPaneKey = new Map<string, string>()
// Why: reverse of ptyPaneKey — callers with a paneKey from outside the PTY lifecycle (e.g. agent-hook status routing) need the ptyId; kept in lock-step via the same sites.
export const paneKeyPtyId = new Map<string, string>()

export function getPtyIdForPaneKey(paneKey: string): string | undefined {
  return paneKeyPtyId.get(paneKey)
}

// Why: let consumers tear down paneKey-scoped state on PTY exit so their timers can't leak; a callback registry keeps the cross-module dependency narrow.
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

export function rememberPaneKeyForPty(ptyId: string, paneKey: unknown): string | null {
  const normalizedPaneKey = typeof paneKey === 'string' ? paneKey.trim() : ''
  if (!isValidPaneKey(normalizedPaneKey)) {
    return null
  }
  // Why: a re-registered ptyId would otherwise leave its old paneKey pointing here.
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
