import { useCallback, useSyncExternalStore } from 'react'
import { pickedSkillsInText } from '../../../../../src/shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session-journal-types'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'

export type MobileNativeChatDraftInputs = {
  images: readonly PendingNativeChatImage[]
  files: readonly PendingNativeChatFile[]
  skills: readonly AgentJournalSkillRef[]
  pending?: number
}
const empty: MobileNativeChatDraftInputs = { images: [], files: [], skills: [] }
const drafts = new Map<string, MobileNativeChatDraftInputs>()
const listeners = new Map<string, Set<() => void>>()
// Operations capture this object: hand-back redirects it; Cancel removes its right to publish.
export type MobileNativeChatDraftDestination = { scope: string; active: boolean }
const destinations = new Map<string, MobileNativeChatDraftDestination>()
export function mobileNativeChatDraftDestination(scope: string): MobileNativeChatDraftDestination {
  let destination = destinations.get(scope)
  if (!destination) {
    destination = { scope, active: true }
    destinations.set(scope, destination)
  }
  return destination
}
export function readMobileNativeChatDraftInputs(scope: string | null): MobileNativeChatDraftInputs {
  return scope ? (drafts.get(scope) ?? empty) : empty
}
export function updateMobileNativeChatDraftInputs(
  target: string | MobileNativeChatDraftDestination,
  update: (current: MobileNativeChatDraftInputs) => MobileNativeChatDraftInputs
): void {
  const destination = typeof target === 'string' ? mobileNativeChatDraftDestination(target) : target
  if (!destination.active) {
    return
  }
  drafts.set(destination.scope, update(readMobileNativeChatDraftInputs(destination.scope)))
  listeners.get(destination.scope)?.forEach((listener) => listener())
}
export function subscribeMobileNativeChatDraftInputs(
  scope: string | null,
  listener: () => void
): () => void {
  if (!scope) {
    return () => {}
  }
  const scoped = listeners.get(scope) ?? new Set<() => void>()
  listeners.set(scope, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0) {
      listeners.delete(scope)
    }
  }
}
export function useMobileNativeChatDraftInputs(scope: string | null): MobileNativeChatDraftInputs {
  const subscribe = useCallback(
    (listener: () => void) => subscribeMobileNativeChatDraftInputs(scope, listener),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => readMobileNativeChatDraftInputs(scope))
}
export function closeMobileNativeChatEditInputs(
  scope: string,
  to?: string,
  kept: readonly PendingNativeChatImage[] = [],
  clean = false
): void {
  const destination = mobileNativeChatDraftDestination(scope)
  const input = readMobileNativeChatDraftInputs(scope)
  if (to) {
    updateMobileNativeChatDraftInputs(to, (current) => ({
      images: [
        ...current.images,
        ...input.images.filter(
          (image) =>
            !kept.some(
              (owned) =>
                owned.id === image.id &&
                owned.path === image.path &&
                owned.previewUri === image.previewUri
            )
        )
      ],
      files: [...current.files, ...(clean ? [] : input.files)],
      skills: [...current.skills, ...(clean ? [] : input.skills)],
      pending: (current.pending ?? 0) + (input.pending ?? 0)
    }))
    destination.scope = to
  } else {
    destination.active = false
  }
  drafts.delete(scope)
  destinations.delete(scope)
  listeners.get(scope)?.forEach((listener) => listener())
}

const textDestinations = new Map<string, (text: string) => boolean | void>()
let focusedScope: string | null = null
export function registerMobileNativeChatTextDestination(
  scope: string,
  insert: (text: string) => boolean | void
): () => void {
  textDestinations.set(scope, insert)
  return () => {
    if (textDestinations.get(scope) === insert) {
      textDestinations.delete(scope)
    }
  }
}
export function focusMobileNativeChatTextDestination(scope: string): void {
  focusedScope = scope
}
export function captureMobileNativeChatTextDestination():
  | ((text: string) => boolean | void)
  | undefined {
  return focusedScope ? textDestinations.get(focusedScope) : undefined
}

export function resetMobileNativeChatDraftInputsForTests(): void {
  drafts.clear()
  destinations.clear()
  textDestinations.clear()
  focusedScope = null
}

export function pruneMobileNativeChatDraftSkills(
  scope: string,
  text: string,
  sigil: '$' | '/' | readonly ('$' | '/')[] = '$'
): void {
  const current = readMobileNativeChatDraftInputs(scope)
  const skills = pickedSkillsInText(
    text,
    current.skills,
    typeof sigil === 'string' ? [sigil] : sigil
  )
  if (skills.length !== current.skills.length) {
    updateMobileNativeChatDraftInputs(scope, (current) => ({ ...current, skills }))
  }
}
