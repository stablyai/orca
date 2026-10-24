import { composerSkillOccurrences } from '../../../src/shared/composer-skill-occurrences'
import { mobileChatDraftStorageKey, type Draft } from './mobile-native-chat-draft-data'
export type { Draft } from './mobile-native-chat-draft-data'
import {
  mobileChatDraftStorage,
  subscribeMobileChatDraftStorage,
  onMobileChatDraftRemoval,
  mobileChatDraftRemoving as removing
} from './mobile-native-chat-draft-storage'
import type { SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
export const EMPTY: Draft = { text: '', images: [], editGeneration: 0 }
export const WAIT_MS = 15_000
export type Copy = {
  draft?: Draft
  expired: boolean
  finish: (saved: boolean) => void
}
type Ordinary = {
  due: boolean
  result: Promise<void>
  finish: (saved: boolean, error?: unknown) => void
}
export type MobileChatDraftOwner = {
  scope: string
  logicalDraft: symbol
  storage: ReturnType<typeof mobileChatDraftStorage>
  draft: Draft
  state: 'unread' | 'recovery' | 'known'
  acknowledged: number | undefined
  error: string | null
  read?: { wait: Promise<void>; finish: () => void }
  active?: { work: Promise<void>; copy?: Copy; ordinary?: Ordinary }
  timer?: ReturnType<typeof setTimeout>
  ordinary?: Ordinary
  copy?: Copy
}
export type MobileChatDraftCopy = { valid: () => boolean }
export const owners = new Map<string, MobileChatDraftOwner>()
const listeners = new Set<() => void>()
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()
export const notify = () => listeners.forEach((listener) => listener())
export const live = (owner: MobileChatDraftOwner) =>
  owners.get(owner.scope) === owner && owner.storage === mobileChatDraftStorage()
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function activate(scope: string): MobileChatDraftOwner {
  let owner = owners.get(scope)
  if (!owner) {
    const storage = mobileChatDraftStorage()
    owner = {
      scope,
      logicalDraft: Symbol(),
      storage,
      draft: EMPTY,
      state: storage ? (removing(scope) ? 'recovery' : 'unread') : 'known',
      acknowledged: undefined,
      error: null
    }
    owners.set(scope, owner)
  }
  return owner
}
export function cancelTimer(owner: MobileChatDraftOwner): void {
  clearTimeout(owner.timer)
  owner.timer = undefined
}
export function retire(owner: MobileChatDraftOwner): void {
  cancelTimer(owner)
  owner.ordinary?.finish(false)
  owner.ordinary = undefined
  owner.active?.ordinary?.finish(false)
  owner.copy?.finish(false)
  owner.read?.finish()
  owners.delete(owner.scope)
}
export function captureMobileChatDraftOwner(scope: string): MobileChatDraftOwner | undefined {
  return owners.get(scope)
}
export const mobileChatDraftOwnerLive = live
subscribeMobileChatDraftStorage(() => {
  const held = [...owners.values()]
  held.forEach(retire)
  for (const owner of held) {
    const next = activate(owner.scope)
    next.logicalDraft = owner.logicalDraft
    next.draft = owner.draft
    next.state = owner.state === 'unread' ? 'recovery' : owner.state
    next.acknowledged = owner.acknowledged
  }
  notify()
})
onMobileChatDraftRemoval((host, workspace) => {
  for (const owner of owners.values()) {
    const [h, w] = owner.scope.split('\0')
    if (h === host && (workspace === undefined || w === workspace)) {
      retire(owner)
    }
  }
  notify()
})
export function problem(owner: MobileChatDraftOwner, message: string): void {
  owner.error = message
  notify()
}
export function request(owner: MobileChatDraftOwner, deferred = false): Promise<void> {
  let ordinary = owner.ordinary
  if (!ordinary) {
    let finish: Ordinary['finish'] = () => {}
    const result = new Promise<void>((resolve, reject) => {
      finish = (saved, error) =>
        saved ? resolve() : reject(error ?? new Error('Draft was not saved'))
    })
    void result.catch(() => undefined)
    ordinary = { due: false, result, finish }
    owner.ordinary = ordinary
  }
  if (!live(owner) || !owner.storage || owner.state !== 'known' || removing(owner.scope)) {
    owner.ordinary = undefined
    ordinary.finish(false)
    return ordinary.result
  }
  ordinary.due ||= !deferred
  cancelTimer(owner)
  if (ordinary.due) {
    pump(owner)
  } else {
    owner.timer = setTimeout(() => {
      owner.timer = undefined
      ordinary.due = true
      pump(owner)
    }, 250)
  }
  return ordinary.result
}
export async function persistMobileNativeChatDraft(scope: string): Promise<void> {
  const owner = owners.get(scope)
  if (!owner) {
    throw new Error('Draft was not saved')
  }
  await request(owner)
}
export function replace(owner: MobileChatDraftOwner, draft: Draft, deferred = false): void {
  if (!live(owner)) {
    return
  }
  owner.draft = draft
  request(owner, deferred)
  notify()
}
export function pump(owner: MobileChatDraftOwner): void {
  const storage = owner.storage
  if (
    !live(owner) ||
    !storage ||
    owner.state !== 'known' ||
    removing(owner.scope) ||
    owner.active
  ) {
    return
  }
  const copy = owner.copy?.draft && !owner.copy.expired ? owner.copy : undefined
  const ordinary = copy ? undefined : owner.ordinary
  if (!copy && !ordinary?.due) {
    return
  }
  const draft = copy?.draft ?? owner.draft
  if (ordinary) {
    owner.ordinary = undefined
    if (owner.acknowledged === draft.editGeneration) {
      ordinary.finish(true)
      return
    }
  }
  const images = draft.images.map(({ previewUri, ...image }) => ({
    ...image,
    ...(/^(https?:|file:|content:)/i.test(previewUri) ? { previewUri } : {})
  }))
  const active: NonNullable<MobileChatDraftOwner['active']> = {
    work: Promise.resolve(),
    copy,
    ordinary
  }
  owner.active = active
  const work = (async () =>
    storage.write(
      mobileChatDraftStorageKey(owner.scope),
      draft.text || images.length
        ? JSON.stringify({
            text: draft.text,
            images,
            ...(draft.skills ? { skills: draft.skills } : {})
          })
        : null
    ))()
  const settled = work
    .then(
      () => {
        if (!live(owner)) {
          ordinary?.finish(false)
          copy?.finish(false)
          return
        }
        ordinary?.finish(true)
        owner.acknowledged = draft.editGeneration
        owner.error = null
        if (copy) {
          copy.finish(!copy.expired)
        }
      },
      (error: unknown) => {
        ordinary?.finish(false, error)
        copy?.finish(false)
        if (live(owner)) {
          if (!copy) {
            problem(
              owner,
              'Your changes are not saved yet. You can still send them. Edit or reopen the chat to try saving again.'
            )
          }
        }
      }
    )
    .finally(() => {
      owner.active = undefined
      if (owner.copy === copy) {
        owner.copy = undefined
      }
      if (live(owner)) {
        pump(owner)
        notify()
      }
    })
  active.work = settled
  void settled.catch(() => undefined)
}
export function writeDraft(
  owner: MobileChatDraftOwner,
  update: SetStateAction<string>,
  userEdit: boolean
): void {
  if (!live(owner)) {
    return
  }
  const current = owner.draft
  const text = typeof update === 'function' ? update(current.text) : update
  replace(
    owner,
    {
      ...current,
      text,
      ...(userEdit
        ? { skills: composerSkillOccurrences(text, current.skills ?? []).map(({ ref }) => ref) }
        : {}),
      editGeneration: current.editGeneration + 1
    },
    true
  )
}
export function setMobileNativeChatDraftText(scope: string, update: SetStateAction<string>): void {
  const owner = owners.get(scope)
  if (owner) {
    writeDraft(owner, update, false)
  }
}
export function editMobileNativeChatDraft(scope: string, update: SetStateAction<string>): void {
  const owner = owners.get(scope)
  if (owner && owner.state !== 'unread') {
    writeDraft(owner, update, true)
  }
}
