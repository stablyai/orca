import { describe, expect, it } from 'vitest'
import {
  buildCollaborationTaskMailboxAddress,
  parseCollaborationTaskMailboxAddress
} from './collaboration-task-mailbox'

describe('buildCollaborationTaskMailboxAddress', () => {
  it('builds an address with the collaboration-task: prefix', () => {
    expect(buildCollaborationTaskMailboxAddress('task-42')).toBe('collaboration-task:task-42')
  })

  it('rejects an empty taskId', () => {
    expect(() => buildCollaborationTaskMailboxAddress('')).toThrow()
    expect(() => buildCollaborationTaskMailboxAddress('   ')).toThrow()
  })

  it('does not normalize the taskId', () => {
    expect(buildCollaborationTaskMailboxAddress('Task 42 / alpha')).toBe(
      'collaboration-task:Task 42 / alpha'
    )
  })
})

describe('parseCollaborationTaskMailboxAddress', () => {
  it('returns the taskId for a matching address', () => {
    expect(parseCollaborationTaskMailboxAddress('collaboration-task:task-42')).toBe('task-42')
  })

  it('round-trips exact taskIds including punctuation after the prefix', () => {
    for (const taskId of ['a:b:c', 'a.b/c', 'a-b_c', 'x y z', '🐙-task', '123']) {
      const address = buildCollaborationTaskMailboxAddress(taskId)
      expect(parseCollaborationTaskMailboxAddress(address)).toBe(taskId)
    }
  })

  it('returns null for an unrelated prefix', () => {
    expect(parseCollaborationTaskMailboxAddress('task:task-42')).toBeNull()
    expect(parseCollaborationTaskMailboxAddress('collaboration-other:task-42')).toBeNull()
  })

  it('treats everything after the prefix as the taskId, including colons', () => {
    expect(parseCollaborationTaskMailboxAddress('collaboration-task:extra:task-42')).toBe(
      'extra:task-42'
    )
  })

  it('returns null for an empty suffix', () => {
    expect(parseCollaborationTaskMailboxAddress('collaboration-task:')).toBeNull()
  })

  it('returns null for an address without a prefix at all', () => {
    expect(parseCollaborationTaskMailboxAddress('task-42')).toBeNull()
    expect(parseCollaborationTaskMailboxAddress('')).toBeNull()
  })
})
