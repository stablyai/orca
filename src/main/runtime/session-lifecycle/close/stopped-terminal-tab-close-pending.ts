import type {
  RestoredPane,
  RestoredPaneTrigger,
  StartedPty
} from '../../terminal/recovery/restored-pane-start'

type TerminalTabCloseOwner = {
  ensureRestoredPaneStarted: (
    pane: RestoredPane,
    trigger?: RestoredPaneTrigger
  ) => Promise<StartedPty | null>
}

const pendingByRuntime = new WeakMap<TerminalTabCloseOwner, Map<string, number>>()

function key(worktreeId: string, tabId: string): string {
  return `${worktreeId}:${tabId}`
}

export function beginStoppedTerminalTabClose(
  runtime: TerminalTabCloseOwner,
  worktreeId: string,
  tabId: string
): () => void {
  const pending = pendingByRuntime.get(runtime) ?? new Map<string, number>()
  pendingByRuntime.set(runtime, pending)
  const tabKey = key(worktreeId, tabId)
  pending.set(tabKey, (pending.get(tabKey) ?? 0) + 1)
  return () => {
    const remaining = (pending.get(tabKey) ?? 1) - 1
    if (remaining) {
      pending.set(tabKey, remaining)
    } else {
      pending.delete(tabKey)
    }
  }
}

export function assertStoppedTerminalTabNotClosing(
  runtime: TerminalTabCloseOwner,
  worktreeId: string,
  tabId: string
): void {
  if (pendingByRuntime.get(runtime)?.has(key(worktreeId, tabId))) {
    throw Object.assign(new Error('Terminal tab is closing.'), { code: 'terminal_tab_live' })
  }
}
