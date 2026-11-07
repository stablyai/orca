import { useSyncExternalStore, type SetStateAction } from 'react'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import {
  resetMobileNativeChatDraftInputsForTests,
  returnMobileNativeChatDraftAttachments,
  closeMobileNativeChatEditInputs,
  mobileNativeChatDraftDestination,
  mobileNativeChatDraftInputScopes,
  pruneMobileNativeChatTabInputs,
  pruneMobileNativeChatDraftSkills,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  type MobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import {
  readMobileNativeChatInFlightSend,
  readMobileNativeChatInFlightSendsByScope,
  registerSavedMobileNativeChatInFlightSends,
  resetMobileNativeChatInFlightSendsForTests,
  retireMobileNativeChatInFlightSends,
  savedMobileNativeChatFiles,
  settleMobileNativeChatInFlightSend
} from './mobile-native-chat-in-flight-sends'
import { dropMobileNativeChatOfflineSends } from './mobile-native-chat-offline-sends'
import {
  closeSavedMobileNativeChatDraft,
  resetMobileNativeChatDraftPersistenceForTests,
  retainSavedMobileNativeChatDrafts,
  saveMobileNativeChatDraft,
  setMobileNativeChatDraftSource
} from './mobile-native-chat-draft-persistence'
import {
  isSavedDraftKept,
  type MobileNativeChatSavedDraft,
  type MobileNativeChatSavedFile,
  type MobileNativeChatSavedImage
} from './mobile-native-chat-saved-drafts'

// Text and its edit revision outlive the screen while its tab remains open.
// Picks behave like desktop chips: user edits drop skills the text stops naming and an origin that stops leading.
type Draft = {
  text: string
  editGeneration: number
  skillOrigin?: string
}

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()

// Seeded launch-context text per scope; null marks a permanent decline so a
// cleared composer never resurrects the prefill, even after leaving the screen.
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()

export function recordMobileNativeChatSkillPick(
  draftKey: string,
  skill: { token: string; path?: string }
): void {
  const current = drafts.get(draftKey) ?? { text: '', editGeneration: 0 }
  const name = skill.token.slice(1)
  // A pick replaces whatever file its token named before, like re-picking a desktop chip.
  updateMobileNativeChatDraftInputs(draftKey, (inputs) => {
    const kept = inputs.skills.filter((held) => held.name !== name)
    return { ...inputs, skills: skill.path ? [...kept, { name, path: skill.path }] : kept }
  })
  drafts.set(draftKey, { ...current, skillOrigin: skill.token })
  saveMobileNativeChatDraft(draftKey, 'deferred')
}

// A rejected send's restored text gets back the files it named, even if newer edits dropped them.
export function restoreMobileNativeChatPickedSkills(
  target: string | MobileNativeChatDraftDestination,
  skills: readonly AgentJournalSkillRef[]
): void {
  const destination = typeof target === 'string' ? mobileNativeChatDraftDestination(target) : target
  const draftKey = destination.scope
  if (!destination.active || !drafts.has(draftKey) || skills.length === 0) {
    return
  }
  const paths = new Set(readMobileNativeChatDraftInputs(draftKey).skills.map((skill) => skill.path))
  updateMobileNativeChatDraftInputs(draftKey, (current) => ({
    ...current,
    skills: [...current.skills, ...skills.filter((skill) => !paths.has(skill.path))]
  }))
  saveMobileNativeChatDraft(draftKey, 'deferred')
}

export function readMobileNativeChatSkillOrigin(draftKey: string): string | null {
  return drafts.get(draftKey)?.skillOrigin ?? null
}

export function readMobileNativeChatPickedSkills(draftKey: string): AgentJournalSkillRef[] {
  return [...readMobileNativeChatDraftInputs(draftKey).skills]
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeDraft(
  target: string | MobileNativeChatDraftDestination,
  update: SetStateAction<string>,
  userEdit: boolean
): void {
  const destination = typeof target === 'string' ? mobileNativeChatDraftDestination(target) : target
  if (!destination.active) {
    return
  }
  const draftKey = destination.scope
  const current = drafts.get(draftKey)
  const text = current?.text ?? ''
  const next = typeof update === 'function' ? update(text) : update
  if (next === text && !userEdit) {
    return
  }
  // Send clears and restores are not edits, so a rejected draft keeps its picks.
  if (userEdit) {
    pruneMobileNativeChatDraftSkills(draftKey, next)
  }
  const skillOrigin =
    userEdit && current?.skillOrigin !== next.split(/\s/, 1)[0] ? undefined : current?.skillOrigin
  drafts.set(draftKey, {
    text: next,
    editGeneration: (current?.editGeneration ?? 0) + 1,
    skillOrigin
  })
  if (next === text) {
    return
  }
  saveMobileNativeChatDraft(draftKey, next === '' ? 'immediate' : 'deferred')
  notifyDrafts()
}

export function setMobileNativeChatDraftText(
  draftKey: string | MobileNativeChatDraftDestination,
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
  target: string | MobileNativeChatDraftDestination,
  editGeneration: number,
  text: string
): void {
  const destination = typeof target === 'string' ? mobileNativeChatDraftDestination(target) : target
  if (!destination.active) {
    return
  }
  const draftKey = destination.scope
  const current = drafts.get(draftKey)
  if ((current?.editGeneration ?? 0) === editGeneration && (current?.text ?? '') === text) {
    setMobileNativeChatDraftText(destination, '')
  }
}

function retireTabText(scope: string): boolean {
  const changed = drafts.delete(scope)
  mobileNativeChatLaunchDraftSeeds.delete(scope)
  retireMobileNativeChatInFlightSends(scope)
  dropMobileNativeChatOfflineSends(scope)
  return changed
}

/** Puts an unconfirmed saved send back in its box, chips included, then forgets it. */
export function returnMobileNativeChatInFlightSend(id: string): void {
  const entry = readMobileNativeChatInFlightSend(id)
  if (!entry) {
    return
  }
  const destination = mobileNativeChatDraftDestination(entry.scope)
  const { send } = entry
  setMobileNativeChatDraftText(destination, (current) =>
    appendReturnedDraftText(current, send.text, { preserveConversationCommands: send.command })
  )
  restoreMobileNativeChatPickedSkills(destination, send.skills)
  returnMobileNativeChatDraftAttachments(
    destination,
    restoredImages(send.images),
    restoredFiles(send.files)
  )
  settleMobileNativeChatInFlightSend(id)
}

// Phone previews die with the page; a restored image chip shows its file name instead.
function restoredImages(images: readonly MobileNativeChatSavedImage[]): PendingNativeChatImage[] {
  return images.map(({ path }) => ({ id: createUuidV4(), path, previewUri: '' }))
}

function restoredFiles(files: readonly MobileNativeChatSavedFile[]): PendingNativeChatFile[] {
  return files.map((file) => ({ ...file, id: createUuidV4() }))
}

function notifyDrafts(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function closeMobileNativeChatTabDraft(scope: string): void {
  closeMobileNativeChatEditInputs(scope)
  closeSavedMobileNativeChatDraft(scope)
  if (retireTabText(scope)) {
    notifyDrafts()
  }
}

export function pruneMobileNativeChatTabDrafts(
  hostId: string,
  worktreeId: string,
  tabIds: readonly string[]
): void {
  let changed = false
  for (const scope of pruneMobileNativeChatTabInputs(hostId, worktreeId, tabIds)) {
    changed = retireTabText(scope) || changed
  }
  retainSavedMobileNativeChatDrafts(hostId, worktreeId, tabIds)
  if (changed) {
    notifyDrafts()
  }
}

// Launch-seed text is prefill, not the user's draft, so it is never saved (desktop's unsavedText rule).
function userText(scope: string): string {
  const text = drafts.get(scope)?.text ?? ''
  return text === mobileNativeChatLaunchDraftSeeds.get(scope)?.text ? '' : text
}

setMobileNativeChatDraftSource({
  saved: () => {
    const saved = new Map<string, MobileNativeChatSavedDraft>()
    const inFlightByScope = readMobileNativeChatInFlightSendsByScope()
    const scopes = [
      ...drafts.keys(),
      ...mobileNativeChatDraftInputScopes(),
      ...inFlightByScope.keys()
    ]
    for (const scope of new Set(scopes)) {
      const inFlight = inFlightByScope.get(scope) ?? []
      // Chips riding a send are saved with it, not twice.
      const sending = new Set(
        inFlight.flatMap((send) => [...send.images, ...send.files]).map((chip) => chip.path)
      )
      const inputs = readMobileNativeChatDraftInputs(scope)
      const text = userText(scope)
      const draft: MobileNativeChatSavedDraft = {
        text,
        skills: text === '' ? [] : inputs.skills,
        skillOrigin: text === '' ? undefined : drafts.get(scope)?.skillOrigin,
        images: inputs.images.flatMap(({ path }) => (sending.has(path) ? [] : [{ path }])),
        files: savedMobileNativeChatFiles(inputs.files).filter((file) => !sending.has(file.path)),
        inFlight
      }
      if (isSavedDraftKept(draft)) {
        saved.set(scope, draft)
      }
    }
    return saved
  },
  restore: (scope, saved) => {
    registerSavedMobileNativeChatInFlightSends(scope, saved.inFlight)
    const current = drafts.get(scope)
    const inputs = readMobileNativeChatDraftInputs(scope)
    // Any write before the load finished, a clear or send included, outranks the saved draft; only untouched prefill yields.
    if (
      (current && current.text !== mobileNativeChatLaunchDraftSeeds.get(scope)?.text) ||
      inputs.images.length > 0 ||
      inputs.files.length > 0
    ) {
      return
    }
    updateMobileNativeChatDraftInputs(scope, (held) => ({
      ...held,
      skills: saved.skills,
      images: restoredImages(saved.images),
      files: restoredFiles(saved.files)
    }))
    if (saved.text !== '') {
      drafts.set(scope, {
        text: saved.text,
        editGeneration: (current?.editGeneration ?? 0) + 1,
        skillOrigin: saved.skillOrigin
      })
      notifyDrafts()
    }
  }
})

export function useMobileNativeChatDraft(draftKey: string | null): string {
  const read = (): string => (draftKey ? (drafts.get(draftKey)?.text ?? '') : '')
  return useSyncExternalStore(subscribe, read, read)
}

export function resetMobileNativeChatDraftStoreForTests(): void {
  resetMobileNativeChatDraftInputsForTests()
  drafts.clear()
  resetMobileNativeChatInFlightSendsForTests()
  mobileNativeChatLaunchDraftSeeds.clear()
  resetMobileNativeChatDraftPersistenceForTests()
}

export type MobileComposerWriter = ((text: string) => boolean) & {
  captureOrigin?: () => (text: string) => boolean
}
