import { useSyncExternalStore, type SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Text and its edit revision outlive the screen, including callbacks from an older mount.
type Draft = { text: string; editGeneration: number }

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()

// Seeded launch-context text per scope; null marks a permanent decline so a
// cleared composer never resurrects the prefill, even after leaving the screen.
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeDraft(draftKey: string, update: SetStateAction<string>, userEdit: boolean): void {
  const current = drafts.get(draftKey)
  const text = current?.text ?? ''
  const next = typeof update === 'function' ? update(text) : update
  if (next === text && !userEdit) {
    return
  }
  drafts.set(draftKey, { text: next, editGeneration: (current?.editGeneration ?? 0) + 1 })
  if (next === text) {
    return
  }
  for (const listener of listeners) {
    listener()
  }
}

export function setMobileNativeChatDraftText(
  draftKey: string,
  update: SetStateAction<string>
): void {
  writeDraft(draftKey, update, false)
}

export function editMobileNativeChatDraft(draftKey: string, update: SetStateAction<string>): void {
  writeDraft(draftKey, update, true)
}

export function readMobileNativeChatDraftEditGeneration(draftKey: string): number {
  return drafts.get(draftKey)?.editGeneration ?? 0
}

export function clearMobileNativeChatDraftForSend(
  draftKey: string,
  editGeneration: number,
  text: string
): void {
  const current = drafts.get(draftKey)
  if ((current?.editGeneration ?? 0) === editGeneration && (current?.text ?? '') === text) {
    setMobileNativeChatDraftText(draftKey, '')
  }
}

export function useMobileNativeChatDraft(draftKey: string | null): string {
  const read = (): string => (draftKey ? (drafts.get(draftKey)?.text ?? '') : '')
  return useSyncExternalStore(subscribe, read, read)
}

export function resetMobileNativeChatDraftStoreForTests(): void {
  drafts.clear()
  mobileNativeChatLaunchDraftSeeds.clear()
}
