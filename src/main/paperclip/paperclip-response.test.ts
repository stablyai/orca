import { describe, expect, it } from 'vitest'
import { parsePaperclipIssue } from './paperclip-response'

const issue = {
  id: 'issue-1',
  identifier: 'PAP-1',
  companyId: 'company-1',
  projectId: 'project-1',
  title: 'Integrate Orca',
  description: null,
  status: 'todo',
  priority: 'high'
}

describe('Paperclip response scope', () => {
  it('accepts an issue inside the bound company and project', () => {
    expect(
      parsePaperclipIssue(issue, { companyId: 'company-1', projectId: 'project-1' })
    ).toMatchObject({ id: 'issue-1', identifier: 'PAP-1' })
  })

  it.each([
    { ...issue, companyId: 'company-2' },
    { ...issue, projectId: 'project-2' },
    { ...issue, companyId: undefined },
    { ...issue, projectId: undefined }
  ])('rejects missing or mismatched provider scope', (value) => {
    expect(() =>
      parsePaperclipIssue(value, { companyId: 'company-1', projectId: 'project-1' })
    ).toThrow(/scope/)
  })
})
