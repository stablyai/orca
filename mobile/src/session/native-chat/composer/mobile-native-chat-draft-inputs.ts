import { useCallback, useSyncExternalStore } from 'react'
import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import { pickedSkillsInText } from '../../../../../src/shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session-journal-types'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import type {
  MobileDictationAnchor,
  MobileDictationPreview
} from '../../../dictation/mobile-dictation-text-insertion'

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
export class MobileNativeChatDraftDestination {
  private redirectedTo: MobileNativeChatDraftDestination | null = null
  private open = true

  constructor(private readonly initialScope: string) {}

  get scope(): string {
    return this.redirectedTo?.scope ?? this.initialScope
  }

  get active(): boolean {
    return this.open && (this.redirectedTo?.active ?? true)
  }

  redirect(to: MobileNativeChatDraftDestination): void {
    this.redirectedTo = to
  }

  close(): void {
    this.open = false
  }
}
const destinations = new Map<string, MobileNativeChatDraftDestination>()
export function mobileNativeChatDraftDestination(scope: string): MobileNativeChatDraftDestination {
  let destination = destinations.get(scope)
  if (!destination) {
    destination = new MobileNativeChatDraftDestination(scope)
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
/** Adds uploaded images to the draft they were picked for, each under a fresh chip id. */
export function addMobileNativeChatDraftImages(
  scope: MobileNativeChatDraftDestination,
  uploadedImages: Omit<PendingNativeChatImage, 'id'>[]
): void {
  updateMobileNativeChatDraftInputs(scope, (current) => ({
    ...current,
    images: [
      ...current.images,
      ...uploadedImages.map((image) => ({ ...image, id: createUuidV4() }))
    ]
  }))
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
  to?: string | MobileNativeChatDraftDestination,
  kept: readonly PendingNativeChatImage[] = [],
  clean = false
): void {
  const destination = mobileNativeChatDraftDestination(scope)
  const input = readMobileNativeChatDraftInputs(scope)
  const target = typeof to === 'string' ? mobileNativeChatDraftDestination(to) : to
  if (target?.active) {
    updateMobileNativeChatDraftInputs(target, (current) => ({
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
    destination.redirect(target)
  } else {
    destination.close()
  }
  drafts.delete(scope)
  destinations.delete(scope)
  listeners.get(scope)?.forEach((listener) => listener())
}

export function pruneMobileNativeChatTabInputs(
  hostId: string,
  worktreeId: string,
  tabIds: readonly string[]
): string[] {
  const prefix = `${hostId}\0${worktreeId}\0`
  const retained = new Set(tabIds.map((id) => `${prefix}${id}`))
  const retired: string[] = []
  for (const scope of destinations.keys()) {
    if (scope.startsWith(prefix) && !retained.has(scope)) {
      closeMobileNativeChatEditInputs(scope)
      retired.push(scope)
    }
  }
  return retired
}

// Read when dictation starts: where its text will land and how to put it there.
export type MobileNativeChatTextDestination = {
  scope: string | null
  anchor: MobileDictationAnchor | null
  insert: (text: string) => boolean | void
}
// The words heard so far, drawn in grey where the destination will put them.
export type MobileNativeChatDictationPreview = MobileDictationPreview & { scope: string | null }
const textDestinations = new Map<string, () => MobileNativeChatTextDestination>()
let focusedScope: string | null = null
export function registerMobileNativeChatTextDestination(
  scope: string,
  capture: () => MobileNativeChatTextDestination
): () => void {
  textDestinations.set(scope, capture)
  return () => {
    if (textDestinations.get(scope) === capture) {
      textDestinations.delete(scope)
    }
  }
}
export function focusMobileNativeChatTextDestination(scope: string): void {
  focusedScope = scope
}
export function captureMobileNativeChatTextDestination():
  | MobileNativeChatTextDestination
  | undefined {
  return focusedScope ? textDestinations.get(focusedScope)?.() : undefined
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
