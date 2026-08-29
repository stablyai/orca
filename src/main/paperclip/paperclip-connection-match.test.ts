import { describe, expect, it } from 'vitest'
import { isPaperclipConnectionMatch } from './client'

const connection = {
  id: 'connection-1',
  origin: 'http://127.0.0.1:3101',
  companyId: 'company-1',
  companyName: 'Company',
  projectId: 'project-1',
  projectName: 'Project'
}

describe('Paperclip admission connection binding', () => {
  it('requires immutable connection, company, and project identity', () => {
    const request = {
      issueId: 'issue-1',
      connectionId: 'connection-1',
      companyId: 'company-1',
      projectId: 'project-1'
    }
    expect(isPaperclipConnectionMatch(connection, request)).toBe(true)
    expect(isPaperclipConnectionMatch(connection, { ...request, connectionId: 'other' })).toBe(
      false
    )
    expect(isPaperclipConnectionMatch(connection, { ...request, companyId: 'other' })).toBe(false)
    expect(isPaperclipConnectionMatch(connection, { ...request, projectId: 'other' })).toBe(false)
  })
})
