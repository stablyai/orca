import { describe, expect, it } from 'vitest'
import type { LinearClientForWorkspace } from '../accounts/linear-account-client'
import type { LinearIssueNode } from './linear-issue-query-documents'
import { mapRawIssueForWorkspace } from './linear-issue-query-support'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapper reads only the workspace id and name.
const entry = {
  workspace: { id: 'workspace-1', organizationName: 'Acme' }
} as unknown as LinearClientForWorkspace

const node: LinearIssueNode = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Task',
  url: 'https://linear.app/acme/issue/ENG-1',
  priority: 0,
  updatedAt: '2026-11-09T00:00:00.000Z',
  project: {
    id: 'p1',
    name: 'Launch',
    url: 'https://linear.app/acme/project/launch',
    color: '#5e6ad2'
  }
}

describe('mapRawIssueForWorkspace', () => {
  it("keeps the project's url and color", () => {
    expect(mapRawIssueForWorkspace(entry, node).project).toEqual({
      id: 'p1',
      name: 'Launch',
      url: 'https://linear.app/acme/project/launch',
      color: '#5e6ad2'
    })
  })
})
