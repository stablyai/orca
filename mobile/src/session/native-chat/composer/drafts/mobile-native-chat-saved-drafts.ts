import type { AgentJournalSkillRef } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'

// The saved shape of a workspace's chat drafts, `{chatDrafts: {[tabId]: draft}}`, in either store.

// Host paths only: a phone preview (data: or blob:) never outlives the page.
export type MobileNativeChatSavedImage = { path: string }
export type MobileNativeChatSavedFile = {
  name: string
  mime: string
  byteLength: number
  path: string
}

// A send whose clear was saved before its outcome was known; reopening keeps it or hands it back.
export type MobileNativeChatInFlightSend = {
  id: string
  kind: 'terminal' | 'structured'
  text: string
  skills: readonly AgentJournalSkillRef[]
  images: readonly MobileNativeChatSavedImage[]
  files: readonly MobileNativeChatSavedFile[]
  sessionId: string | null
  clientMessageId?: string
  normalizedText: string
  baselineTailMessageId: string | null
  queuedDuringWork?: boolean
  command?: boolean
}

// A message queued while the desktop was out; it comes back paused, never sent by itself.
export type MobileNativeChatSavedQueuedSend = {
  text: string
  alternate?: true
  goal?: true
  skills: readonly AgentJournalSkillRef[]
  skillOrigin: string | null
  images: readonly MobileNativeChatSavedImage[]
  files: readonly MobileNativeChatSavedFile[]
}

export type MobileNativeChatSavedDraft = {
  text: string
  skills: readonly AgentJournalSkillRef[]
  skillOrigin?: string
  images: readonly MobileNativeChatSavedImage[]
  files: readonly MobileNativeChatSavedFile[]
  inFlight: readonly MobileNativeChatInFlightSend[]
  queued?: readonly MobileNativeChatSavedQueuedSend[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseList<T>(value: unknown, parse: (item: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = isRecord(item) ? parse(item) : null
        return parsed === null ? [] : [parsed]
      })
    : []
}

const parseSkill = (skill: Record<string, unknown>): AgentJournalSkillRef | null =>
  typeof skill.name === 'string' && typeof skill.path === 'string'
    ? { name: skill.name, path: skill.path }
    : null

const parseImage = (image: Record<string, unknown>): MobileNativeChatSavedImage | null =>
  typeof image.path === 'string' && image.path !== '' ? { path: image.path } : null

const parseFile = (file: Record<string, unknown>): MobileNativeChatSavedFile | null =>
  typeof file.path === 'string' &&
  typeof file.name === 'string' &&
  typeof file.mime === 'string' &&
  typeof file.byteLength === 'number'
    ? { name: file.name, mime: file.mime, byteLength: file.byteLength, path: file.path }
    : null

function parseInFlight(send: Record<string, unknown>): MobileNativeChatInFlightSend | null {
  if (
    typeof send.id !== 'string' ||
    (send.kind !== 'terminal' && send.kind !== 'structured') ||
    typeof send.text !== 'string' ||
    typeof send.normalizedText !== 'string'
  ) {
    return null
  }
  return {
    id: send.id,
    kind: send.kind,
    text: send.text,
    skills: parseList(send.skills, parseSkill),
    images: parseList(send.images, parseImage),
    files: parseList(send.files, parseFile),
    sessionId: typeof send.sessionId === 'string' ? send.sessionId : null,
    ...(typeof send.clientMessageId === 'string' ? { clientMessageId: send.clientMessageId } : {}),
    normalizedText: send.normalizedText,
    baselineTailMessageId:
      typeof send.baselineTailMessageId === 'string' ? send.baselineTailMessageId : null,
    ...(send.queuedDuringWork === true ? { queuedDuringWork: true } : {}),
    ...(send.command === true ? { command: true } : {})
  }
}

function parseQueued(send: Record<string, unknown>): MobileNativeChatSavedQueuedSend | null {
  if (typeof send.text !== 'string') {
    return null
  }
  return {
    text: send.text,
    ...(send.alternate === true ? { alternate: true } : {}),
    ...(send.goal === true ? { goal: true } : {}),
    skills: parseList(send.skills, parseSkill),
    skillOrigin: typeof send.skillOrigin === 'string' ? send.skillOrigin : null,
    images: parseList(send.images, parseImage),
    files: parseList(send.files, parseFile)
  }
}

// Anything else, including an older build's terminal drafts, reads as no drafts.
export function parseSavedDrafts(value: unknown): Map<string, MobileNativeChatSavedDraft> {
  const saved = new Map<string, MobileNativeChatSavedDraft>()
  if (!isRecord(value) || !isRecord(value.chatDrafts)) {
    return saved
  }
  for (const [tabId, draft] of Object.entries(value.chatDrafts)) {
    if (!isRecord(draft) || typeof draft.text !== 'string') {
      continue
    }
    const parsed: MobileNativeChatSavedDraft = {
      text: draft.text,
      skills: parseList(draft.skills, parseSkill),
      skillOrigin: typeof draft.skillOrigin === 'string' ? draft.skillOrigin : undefined,
      images: parseList(draft.images, parseImage),
      files: parseList(draft.files, parseFile),
      inFlight: parseList(draft.inFlight, parseInFlight),
      queued: parseList(draft.queued, parseQueued)
    }
    if (isSavedDraftKept(parsed)) {
      saved.set(tabId, parsed)
    }
  }
  return saved
}

export function isSavedDraftKept(draft: MobileNativeChatSavedDraft): boolean {
  return (
    draft.text !== '' ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.inFlight.length > 0 ||
    (draft.queued?.length ?? 0) > 0
  )
}

export function savedDraftsValue(drafts: ReadonlyMap<string, MobileNativeChatSavedDraft>): unknown {
  return drafts.size === 0 ? null : { chatDrafts: Object.fromEntries(drafts) }
}

// Drafts that would push the value past its cap stay in memory, so a refused write never leaves sent text stored.
export function fitSavedDrafts<Encoded>(
  value: unknown,
  encode: (value: unknown) => Encoded,
  fits: (encoded: Encoded) => boolean
): Encoded {
  const drafts = parseSavedDrafts(value)
  const whole = encode(savedDraftsValue(drafts))
  if (drafts.size === 0 || fits(whole)) {
    return whole
  }
  const kept = new Map<string, MobileNativeChatSavedDraft>()
  for (const [tabId, draft] of drafts) {
    kept.set(tabId, draft)
    if (!fits(encode(savedDraftsValue(kept)))) {
      kept.delete(tabId)
    }
  }
  return encode(savedDraftsValue(kept))
}
