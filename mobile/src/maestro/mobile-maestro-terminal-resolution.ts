import { makePaneKey, parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { RpcClient } from '../transport/rpc-client'

export function resolveMaestroTerminalPaneKey(
  terminalTabId: string,
  paneKey: string
): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId === terminalTabId ? paneKey : null
  }
  if (paneKey.includes(':')) {
    return null
  }
  try {
    return makePaneKey(terminalTabId, paneKey)
  } catch {
    return null
  }
}

export function readResolvedTerminalHandle(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const terminal = (value as { terminal?: unknown }).terminal
  if (!terminal || typeof terminal !== 'object') {
    return null
  }
  const handle = (terminal as { handle?: unknown }).handle
  return typeof handle === 'string' && handle.length > 0 ? handle : null
}

type ListedTerminalIdentity = {
  handle: string
  ptyId: string | null
  tabId: string
  leafId: string
}

function readListedTerminals(value: unknown): ListedTerminalIdentity[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const terminals = (value as { terminals?: unknown }).terminals
  if (!Array.isArray(terminals)) {
    return []
  }
  return terminals.flatMap((terminal) => {
    if (!terminal || typeof terminal !== 'object') {
      return []
    }
    const candidate = terminal as Record<string, unknown>
    return typeof candidate.handle === 'string' &&
      (typeof candidate.ptyId === 'string' || candidate.ptyId === null) &&
      typeof candidate.tabId === 'string' &&
      typeof candidate.leafId === 'string'
      ? [
          {
            handle: candidate.handle,
            ptyId: candidate.ptyId,
            tabId: candidate.tabId,
            leafId: candidate.leafId
          }
        ]
      : []
  })
}

export async function resolveMobileMaestroTerminalHandle({
  client,
  terminalTabId,
  paneKey,
  worktreeId,
  sessionId
}: {
  client: Pick<RpcClient, 'sendRequest'>
  terminalTabId: string
  paneKey: string
  worktreeId: string | null
  sessionId: string | null
}): Promise<string | null> {
  const stablePaneKey = resolveMaestroTerminalPaneKey(terminalTabId, paneKey)
  if (stablePaneKey) {
    const response = await client
      .sendRequest('terminal.resolvePane', {
        paneKey: stablePaneKey,
        worktreeId: worktreeId ?? undefined
      })
      .catch(() => null)
    if (response?.ok) {
      const handle = readResolvedTerminalHandle(response.result)
      if (handle) {
        return handle
      }
    }
  }
  if (!sessionId) {
    return null
  }
  const listResponse = await client
    .sendRequest('terminal.list', {
      worktree: worktreeId ? `id:${worktreeId}` : undefined,
      includeVisualLayouts: false
    })
    .catch(() => null)
  if (!listResponse?.ok) {
    return null
  }
  const candidates = readListedTerminals(listResponse.result).filter(
    (terminal) => terminal.ptyId === sessionId
  )
  const leafId = parsePaneKey(stablePaneKey ?? '')?.leafId ?? paneKey
  const exact = candidates.filter(
    (terminal) => terminal.tabId === terminalTabId && terminal.leafId === leafId
  )
  if (exact.length === 1) {
    return exact[0]!.handle
  }
  return candidates.length === 1 ? candidates[0]!.handle : null
}
