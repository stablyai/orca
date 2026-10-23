import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { useSyncExternalStore, useCallback, type SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Text and its edit revision outlive the screen, including callbacks from an older mount.
type Draft = {
  text: string
  editGeneration: number
  images?: PendingNativeChatImage[]
  files?: readonly PendingNativeChatFile[]
}

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
  drafts.set(draftKey, {
    ...current,
    text: next,
    editGeneration: (current?.editGeneration ?? 0) + 1
  })
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
  attachmentId = 0
  mobileNativeChatLaunchDraftSeeds.clear()
}

const noImages: PendingNativeChatImage[] = []
const noFiles: readonly PendingNativeChatFile[] = []
let attachmentId = 0
export function nextMobileDraftAttachmentId(prefix: string): string {
  return `${prefix}-${++attachmentId}`
}

export function useMobileDraftAttachments<K extends 'images' | 'files'>(
  scope: string | null,
  kind: K
) {
  const empty = kind === 'images' ? noImages : noFiles
  const read = () => (scope ? drafts.get(scope)?.[kind] : undefined) ?? empty
  // SAFETY: the selected key and fallback always have Draft[K]'s element type.
  const value = useSyncExternalStore(subscribe, read, read) as NonNullable<Draft[K]>
  const update = useCallback(
    (key: string, change: (current: NonNullable<Draft[K]>) => NonNullable<Draft[K]>) => {
      const current = drafts.get(key) ?? { text: '', editGeneration: 0 }
      // SAFETY: the key selects the same attachment type for reading and writing.
      const next = change((current[kind] ?? empty) as NonNullable<Draft[K]>)
      drafts.set(key, { ...current, [kind]: next })
      for (const listener of listeners) {
        listener()
      }
    },
    [kind, empty]
  )
  return [value, update] as const
}

export type MobileComposerWriter = ((text: string) => boolean) & {
  captureOrigin?: () => (text: string) => boolean
}
