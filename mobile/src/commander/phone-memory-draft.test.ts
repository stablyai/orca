import { expect, it } from 'vitest'
import { readHandoff } from '../../../src/shared/commander/goal-handoff'
import {
  applyRecentConversation,
  draftWrite,
  newHandoffDraft,
  updateMemoryDraft
} from './phone-memory-draft'

it('retries the same portable handoff write until edited, preserving the project, page, and user-authored goal', () => {
  const original = updateMemoryDraft(newHandoffDraft('repo'), { title: 'My goal' })
  const first = draftWrite(original)
  expect(draftWrite(original)).toEqual(first)

  const captured = applyRecentConversation(original, { goal: 'Old goal', progress: 'Tests passed' })
  if (!captured) {
    throw new Error('Expected a handoff')
  }
  const edited = draftWrite(captured)
  if (edited.deleted) {
    throw new Error('Expected a live handoff')
  }
  expect(edited).toMatchObject({ projectId: 'repo', pageId: first.pageId, expectedVersion: 0 })
  expect(edited.requestId).not.toEqual(first.requestId)
  expect(readHandoff({ ...edited, deleted: false })).toEqual({
    goal: 'My goal',
    progress: 'Tests passed',
    nextStep: ''
  })
})
