import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../src/shared/native-chat-image-transcript-markers'
import {
  mobileChatDraftStorageKey,
  parseMobileChatDraft,
  combine,
  type Draft
} from './mobile-native-chat-draft-data'
import {
  mobileChatDraftStorage,
  mobileChatDraftRemoving as removing,
  removeMobileChatDraftScopes,
  retryMobileChatDraftRemovals
} from './mobile-native-chat-draft-storage'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { useSyncExternalStore } from 'react'
import {
  EMPTY,
  WAIT_MS,
  owners,
  mobileNativeChatLaunchDraftSeeds,
  notify,
  live,
  subscribe,
  activate,
  cancelTimer,
  retire,
  problem,
  request,
  replace,
  pump,
  type Copy,
  type MobileChatDraftOwner,
  type MobileChatDraftCopy
} from './mobile-native-chat-draft-owner'
export {
  mobileNativeChatLaunchDraftSeeds,
  setMobileNativeChatDraftText,
  editMobileNativeChatDraft,
  persistMobileNativeChatDraft,
  captureMobileChatDraftOwner,
  mobileChatDraftOwnerLive,
  type MobileChatDraftOwner,
  type MobileChatDraftCopy
} from './mobile-native-chat-draft-owner'
export function resolveMobileChatDraftSendOwner(captured: MobileChatDraftOwner | undefined) {
  const current = captured && owners.get(captured.scope)
  return current && current.logicalDraft === captured?.logicalDraft && live(current)
    ? current
    : undefined
}
export function clearMobileNativeChatDraftForSend(
  captured: MobileChatDraftOwner | undefined,
  generation: number,
  text: string
): void {
  const owner = resolveMobileChatDraftSendOwner(captured)
  if (!owner) {
    return
  }
  const current = owner.draft
  if (current.editGeneration === generation && current.text === text) {
    replace(owner, { ...current, text: '', skills: undefined, editGeneration: generation + 1 })
  }
}
export function restoreMobileChatDraft(
  captured: MobileChatDraftOwner,
  text: string,
  skills?: Draft['skills']
): void {
  const owner = resolveMobileChatDraftSendOwner(captured)
  if (!owner) {
    return
  }
  const current = owner.draft
  if (
    current.text === text &&
    JSON.stringify(current.skills ?? []) === JSON.stringify(skills ?? [])
  ) {
    return
  }
  replace(owner, combine(current, { text, images: [], skills }, true))
}
export function readMobileNativeChatDraft(scope: string): Draft {
  return owners.get(scope)?.draft ?? EMPTY
}
export function updateMobileNativeChatDraftImages(
  captured: MobileChatDraftOwner | undefined,
  update: (images: PendingNativeChatImage[]) => PendingNativeChatImage[],
  previewOnly = false
): void {
  if (!captured || !live(captured)) {
    return
  }
  const current = captured.draft
  const images = update(current.images)
  const next = {
    ...current,
    text: imageReferencesToPromptMarkers(
      promptMarkersToImageReferences(
        current.text,
        current.images.map((image) => image.id)
      ),
      images.map((image) => image.id)
    ),
    images,
    editGeneration: current.editGeneration + (previewOnly ? 0 : 1)
  }
  if (previewOnly) {
    captured.draft = next
    notify()
  } else {
    replace(captured, next)
  }
}
export function hydrateMobileNativeChatDraft(scope: string): Promise<void> {
  const loaded = loadMobileNativeChatDraft(scope)
  const owner = owners.get(scope)
  if (owner?.state === 'known' && owner.draft.editGeneration !== (owner.acknowledged ?? 0)) {
    request(owner)
  }
  return loaded
}
async function loadMobileNativeChatDraft(scope: string): Promise<void> {
  const owner = activate(scope)
  retryMobileChatDraftRemovals()
  if (!owner.storage || owner.state === 'known' || removing(scope)) {
    return
  }
  if (owner.read) {
    return owner.state === 'recovery' ? Promise.resolve() : owner.read.wait
  }
  let timer: ReturnType<typeof setTimeout>
  let finish = () => {}
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  owner.read = { wait, finish }
  const failed = () => {
    if (live(owner)) {
      owner.state = 'recovery'
      problem(
        owner,
        "Your saved draft couldn't be opened. New changes are not saved yet. You can still send them. Reopen the chat to try again."
      )
    }
    finish()
  }
  timer = setTimeout(failed, WAIT_MS)
  void owner.storage
    .read(mobileChatDraftStorageKey(scope))
    .then((value) => {
      if (!live(owner)) {
        return
      }
      const saved = parseMobileChatDraft(value)
      if (value !== null && !saved) {
        throw new Error('Unreadable saved draft')
      }
      if (saved) {
        const loaded = {
          ...saved,
          images: saved.images.map((image) => ({
            ...image,
            previewUri: image.previewUri ?? image.reference?.url ?? ''
          })),
          editGeneration: owner.draft.editGeneration
        }
        owner.draft =
          owner.draft.text || owner.draft.images.length
            ? combine(loaded, owner.draft, true)
            : loaded
      }
      owner.state = 'known'
      owner.error = null
      if (owner.draft.editGeneration !== (owner.acknowledged ?? 0)) {
        request(owner)
      }
      notify()
    })
    .catch(failed)
    .finally(() => {
      clearTimeout(timer)
      owner.read = undefined
      finish()
    })
  return wait
}
export async function appendMobileNativeChatDraft(
  scope: string,
  addition: Pick<Draft, 'text' | 'images' | 'skills'>
): Promise<MobileChatDraftCopy | false> {
  const owner = activate(scope)
  if (!owner.storage || owner.copy || removing(scope)) {
    return false
  }
  let timer: ReturnType<typeof setTimeout>
  let resolve = (_saved: boolean) => {}
  const result = new Promise<boolean>((done) => {
    resolve = done
  })
  const copy: Copy = {
    expired: false,
    finish: (saved) => {
      clearTimeout(timer)
      resolve(saved && live(owner))
    }
  }
  owner.copy = copy
  timer = setTimeout(() => {
    copy.expired = true
    if (owner.active?.copy !== copy && owner.copy === copy) {
      owner.copy = undefined
    }
    copy.finish(false)
    notify()
  }, WAIT_MS)
  notify()
  void loadMobileNativeChatDraft(scope).then(() => {
    if (!live(owner) || owner.state !== 'known' || owner.copy !== copy || copy.expired) {
      copy.finish(false)
      return
    }
    copy.draft = combine(owner.draft, addition)
    owner.draft = copy.draft
    const ordinary = owner.ordinary
    owner.ordinary = undefined
    cancelTimer(owner)
    if (ordinary) {
      void result.then((saved) => ordinary.finish(saved))
    }
    pump(owner)
    notify()
  })
  const saved = await result
  if (owner.copy === copy && owner.active?.copy !== copy) {
    owner.copy = undefined
  }
  notify()
  return saved ? { valid: () => !copy.expired && live(owner) && !removing(scope) } : false
}
export function mobileChatDraftLifecycle(foreground: boolean): void {
  if (foreground) {
    retryMobileChatDraftRemovals()
  }
  for (const owner of owners.values()) {
    if (foreground && owner.state !== 'known') {
      void hydrateMobileNativeChatDraft(owner.scope)
    }
    if (owner.draft.editGeneration !== (owner.acknowledged ?? 0)) {
      request(owner)
    }
  }
}
export function deleteMobileNativeChatDrafts(hostId: string, workspaceId?: string): Promise<void> {
  return removeMobileChatDraftScopes(hostId, workspaceId)
}
export function useMobileNativeChatDraft(scope: string | null): string {
  const read = () => (scope ? readMobileNativeChatDraft(scope).text : '')
  return useSyncExternalStore(subscribe, read, read)
}
export function useMobileNativeChatDraftImages(scope: string | null): PendingNativeChatImage[] {
  const read = () => (scope ? readMobileNativeChatDraft(scope).images : EMPTY.images)
  return useSyncExternalStore(subscribe, read, read)
}
export function useMobileNativeChatDraftHydrated(scope: string | null): boolean {
  const read = () => !scope || !mobileChatDraftStorage() || owners.get(scope)?.state === 'known'
  return useSyncExternalStore(subscribe, read, read)
}
export function useMobileChatDraftStatus(scope: string | null): {
  ready: boolean
  error: string | null
} {
  const ready = useSyncExternalStore(
    subscribe,
    () =>
      !scope ||
      !mobileChatDraftStorage() ||
      owners.get(scope)?.state === 'known' ||
      owners.get(scope)?.state === 'recovery'
  )
  const error = useSyncExternalStore(subscribe, () =>
    scope ? (owners.get(scope)?.error ?? null) : null
  )
  return { ready, error }
}
export function resetMobileNativeChatDraftStoreForTests(): void {
  for (const owner of owners.values()) {
    retire(owner)
  }
  mobileNativeChatLaunchDraftSeeds.clear()
}
export function useMobileChatDraftRuntime() {
  return useSyncExternalStore(subscribe, mobileChatDraftStorage)
}
