import { describe, expect, it } from 'vitest'
import { isGitHubProjectFieldEmpty } from './github-project-field-emptiness'

const row = {
  content: {
    assignees: [],
    labels: [],
    repository: null,
    parentIssue: null,
    issueType: null
  },
  fieldValuesByFieldId: {
    blank: { kind: 'text', text: '' },
    count: { kind: 'number' },
    labels: { kind: 'labels', labels: [] },
    users: { kind: 'users', users: [] }
  }
}

describe('GitHub Project field emptiness', () => {
  it.each(['ASSIGNEES', 'LABELS', 'REPOSITORY', 'PARENT_ISSUE', 'ISSUE_TYPE'])(
    'recognizes an empty %s field',
    (dataType) => {
      expect(isGitHubProjectFieldEmpty(row, { id: dataType, dataType })).toBe(true)
    }
  )

  it.each(['missing', 'blank', 'labels', 'users'])(
    'recognizes empty stored field value %s',
    (id) => {
      expect(isGitHubProjectFieldEmpty(row, { id, dataType: 'TEXT' })).toBe(true)
    }
  )

  it('does not mistake zero or a title for an empty value', () => {
    expect(isGitHubProjectFieldEmpty(row, { id: 'count', dataType: 'NUMBER' })).toBe(false)
    expect(isGitHubProjectFieldEmpty(row, { id: 'title', dataType: 'TITLE' })).toBe(false)
  })
})
