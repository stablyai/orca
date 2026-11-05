// Phone-only, for this launch. The session route clears paneKey after it applies, so the sidebar cannot read it back.
import { useSyncExternalStore } from 'react'

export type SelectedSidebarSession = {
  worktreeId: string
  paneKey: string
}

let selected: SelectedSidebarSession | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function getSelectedSidebarSession(): SelectedSidebarSession | null {
  return selected
}

export function subscribeSelectedSidebarSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setSelectedSidebarSession(next: SelectedSidebarSession | null): void {
  if (selected?.worktreeId === next?.worktreeId && selected?.paneKey === next?.paneKey) {
    return
  }
  selected = next
  emit()
}

export function useSelectedSidebarSession(): SelectedSidebarSession | null {
  return useSyncExternalStore(
    subscribeSelectedSidebarSession,
    getSelectedSidebarSession,
    getSelectedSidebarSession
  )
}
