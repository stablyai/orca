import type { PreparedLaunchSetupTab } from '../../../../shared/prepared-agent-launch'

// Derived from main's live publications: an entry exists only while a pending launch's revealed
// Setup still waits for its agent, and dies when that publication ends however it ends.
const waiting = new Map<string, PreparedLaunchSetupTab>()
const listeners = new Set<(tabs: PreparedLaunchSetupTab[]) => void>()

export function listWaitingPreparedSetups(): PreparedLaunchSetupTab[] {
  return [...waiting.values()]
}

/** Each window's copy follows every change; a window that loads later asks for the list. */
export function onWaitingPreparedSetupsChanged(
  listener: (tabs: PreparedLaunchSetupTab[]) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setWaitingPreparedSetup(
  operationId: string,
  tab: PreparedLaunchSetupTab | undefined
): void {
  const current = waiting.get(operationId)
  if (tab ? current?.tabId === tab.tabId && current.worktreeId === tab.worktreeId : !current) {
    return
  }
  if (tab) {
    waiting.set(operationId, tab)
  } else {
    waiting.delete(operationId)
  }
  const tabs = listWaitingPreparedSetups()
  for (const listener of listeners) {
    listener(tabs)
  }
}
