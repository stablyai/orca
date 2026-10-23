import { describe, expect, it } from 'vitest'
import { getOptionalClickUpTaskLinkFlag } from './worktree-clickup-task-link'

describe('getOptionalClickUpTaskLinkFlag', () => {
  it('clears the previous Workspace when linking a task without a Workspace', () => {
    expect(
      getOptionalClickUpTaskLinkFlag(new Map([['clickup-task', '86abc123']]), { allowNull: true })
    ).toEqual({
      linkedClickUpTaskId: '86abc123',
      linkedClickUpWorkspaceId: null
    })
  })
})
