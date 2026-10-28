import { useSyncExternalStore, type SetStateAction } from 'react'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session-journal-types'
import { pickedSkillsInText } from '../../../../../src/shared/structured-agent-session-send-mutation'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Text and its edit revision outlive the screen, including callbacks from an older mount.
// Picks behave like desktop chips: user edits drop skills the text stops naming and an origin that stops leading.
type Draft = {
  text: string
  editGeneration: number
  skills?: AgentJournalSkillRef[]
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
  const kept = (current.skills ?? []).filter((held) => held.name !== name)
  const skills = skill.path ? [...kept, { name, path: skill.path }] : kept
  drafts.set(draftKey, { ...current, skillOrigin: skill.token, skills })
}

// A rejected send's restored text gets back the files it named, even if newer edits dropped them.
export function restoreMobileNativeChatPickedSkills(
  draftKey: string,
  skills: readonly AgentJournalSkillRef[]
): void {
  const current = drafts.get(draftKey)
  if (!current || skills.length === 0) {
    return
  }
  const paths = new Set((current.skills ?? []).map((skill) => skill.path))
  drafts.set(draftKey, {
    ...current,
    skills: [...(current.skills ?? []), ...skills.filter((skill) => !paths.has(skill.path))]
  })
}

export function readMobileNativeChatSkillOrigin(draftKey: string): string | null {
  return drafts.get(draftKey)?.skillOrigin ?? null
}

export function readMobileNativeChatPickedSkills(draftKey: string): AgentJournalSkillRef[] {
  return drafts.get(draftKey)?.skills ?? []
}

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
  // Send clears and restores are not edits, so a rejected draft keeps its picks.
  const skills =
    userEdit && current?.skills ? pickedSkillsInText(next, current.skills) : current?.skills
  const skillOrigin =
    userEdit && current?.skillOrigin !== next.split(/\s/, 1)[0] ? undefined : current?.skillOrigin
  drafts.set(draftKey, {
    text: next,
    editGeneration: (current?.editGeneration ?? 0) + 1,
    ...(skills ? { skills } : {}),
    ...(skillOrigin ? { skillOrigin } : {})
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
  mobileNativeChatLaunchDraftSeeds.clear()
}
