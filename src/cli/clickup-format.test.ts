import { describe, expect, it } from 'vitest'
import { formatClickUpLists } from './clickup-format'

describe('formatClickUpLists', () => {
  it('preserves five TSV columns when optional hierarchy names are missing', () => {
    expect(
      formatClickUpLists([
        {
          id: 'list-1',
          workspaceId: 'team-1',
          workspaceName: 'Engineering',
          name: 'Inbox',
          statuses: []
        }
      ])
    ).toBe('list-1\tEngineering\t\t\tInbox')
  })
})
