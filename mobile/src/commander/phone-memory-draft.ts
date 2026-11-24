import {
  createHandoffPageId,
  encodeHandoffBody,
  HANDOFF_GOAL_LIMIT,
  HANDOFF_SECTION_LIMIT,
  readHandoff
} from '../../../src/shared/commander/goal-handoff'
import {
  recurringAnswerTitle,
  humanRecurringAnswer,
  formatRecurringAnswer,
  recurringQuestionLimit,
  recurringAnswerLimit
} from '../../../src/shared/commander/recurring-answer'
import { createNonSecureContextUuid as uuid } from '../../../src/shared/identifiers/non-secure-context-uuid'
import type {
  CommanderMemoryRevision,
  CommanderMemoryWrite
} from '../../../src/shared/commander/memory-contract'

export type MemoryDraft = {
  recurring?: { question: string; answer: string }
  title: string
  body: string
  kind: CommanderMemoryRevision['kind']
  projectId: string | null
  pageId: string
  requestId: string
  expectedVersion: number
  links: string[]
}

export function memoryDraft(page?: CommanderMemoryRevision): MemoryDraft {
  const recurring = page && humanRecurringAnswer(page)
  return {
    ...(recurring ? { recurring } : {}),
    title: page?.title ?? '',
    body: page?.body ?? '',
    kind: page?.kind ?? 'note',
    projectId: page?.projectId ?? null,
    pageId: page?.pageId ?? uuid(),
    requestId: uuid(),
    expectedVersion: page?.version ?? 0,
    links: page?.links ?? []
  }
}

export function updateMemoryDraft(
  draft: MemoryDraft,
  patch: Partial<Pick<MemoryDraft, 'title' | 'body' | 'kind' | 'projectId' | 'recurring'>>
): MemoryDraft {
  return { ...draft, ...patch, requestId: uuid() }
}

export function draftWrite(draft: MemoryDraft): CommanderMemoryWrite {
  const { recurring, ...write } = draft
  if (!recurring) {
    return { ...write, title: write.title.trim() }
  }
  if (!validRecurringDraft(draft)) {
    throw new Error('Invalid recurring answer.')
  }
  return {
    ...write,
    title: recurringAnswerTitle,
    kind: 'guideline',
    body: formatRecurringAnswer(recurring.question.trim(), recurring.answer.trim())
  }
}

export function newRecurringDraft(projectId: string | null): MemoryDraft {
  return {
    ...memoryDraft(),
    title: recurringAnswerTitle,
    kind: 'guideline',
    projectId,
    recurring: { question: '', answer: '' }
  }
}

export function validRecurringDraft(draft: MemoryDraft): boolean {
  const fields = draft.recurring
  return !!(
    draft.projectId &&
    fields?.question.trim() &&
    fields.answer.trim() &&
    fields.question.trim().length <= recurringQuestionLimit &&
    fields.answer.trim().length <= recurringAnswerLimit
  )
}

export function newHandoffDraft(projectId: string | null = null): MemoryDraft {
  const empty = { progress: '', nextStep: '' }
  return {
    ...memoryDraft(),
    projectId,
    pageId: createHandoffPageId(),
    body: encodeHandoffBody(empty)
  }
}

// A goal is required on save; its blank form still needs to decode its two editable sections.
export function draftHandoffFields(draft: MemoryDraft) {
  return readHandoff({ ...draft, title: draft.title.trim() || 'Goal', deleted: false })
}

export function applyRecentConversation(
  draft: MemoryDraft | null,
  recent: { goal: string; progress: string }
): MemoryDraft | null {
  if (!draft) {
    return null
  }
  const fields = draftHandoffFields(draft)
  if (!fields) {
    return draft
  }
  return updateMemoryDraft(draft, {
    title: draft.title.trim() ? draft.title : recent.goal.slice(0, HANDOFF_GOAL_LIMIT),
    body: encodeHandoffBody({
      ...fields,
      progress: fields.progress.trim()
        ? fields.progress
        : recent.progress.slice(0, HANDOFF_SECTION_LIMIT)
    })
  })
}
