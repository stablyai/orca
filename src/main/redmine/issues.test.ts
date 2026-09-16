import { describe, expect, it, vi, beforeEach } from 'vitest'
import { redmineRequest } from './redmine-request'
import { mapRedmineIssue } from './mappers'
import { listRedmineIssues, getRedmineIssue } from './issues'

vi.mock('./redmine-request', () => ({
  classifyRedmineError: vi.fn(),
  redmineRequest: vi.fn()
}))

vi.mock('./mappers', () => ({
  mapRedmineIssue: vi.fn()
}))

const redmineRequestMock = vi.mocked(redmineRequest)
const mapRedmineIssueMock = vi.mocked(mapRedmineIssue)

const rawIssue = { id: 1, subject: 'x' }

beforeEach(() => {
  vi.clearAllMocks()
  redmineRequestMock.mockResolvedValue({ issues: [rawIssue], total_count: 1 })
  mapRedmineIssueMock.mockReturnValue({ id: 1 } as never)
})

describe('listRedmineIssues pagination', () => {
  it('clamps limit to 100 and derives offset from the clamped value', async () => {
    await listRedmineIssues('https://x.example', 'k', { limit: 200, page: 2 })
    expect(redmineRequestMock).toHaveBeenCalledWith(
      'https://x.example',
      'k',
      '/issues.json?limit=100&offset=100',
      expect.anything()
    )
  })

  it('bounds a negative limit to 1', async () => {
    await listRedmineIssues('https://x.example', 'k', { limit: -5, page: 1 })
    expect(redmineRequestMock).toHaveBeenCalledWith(
      'https://x.example',
      'k',
      '/issues.json?limit=1&offset=0',
      expect.anything()
    )
  })

  it('defaults to a 20-item first page when no filter is given', async () => {
    await listRedmineIssues('https://x.example', 'k')
    expect(redmineRequestMock).toHaveBeenCalledWith(
      'https://x.example',
      'k',
      '/issues.json?limit=20&offset=0',
      expect.anything()
    )
  })
})

describe('getRedmineIssue', () => {
  it('maps the detail response through the issue mapper', async () => {
    redmineRequestMock.mockResolvedValue({ issue: rawIssue })
    const result = await getRedmineIssue('https://x.example', 'k', 1)
    expect(redmineRequestMock).toHaveBeenCalledWith(
      'https://x.example',
      'k',
      '/issues/1.json?include=journals,attachments',
      expect.anything()
    )
    expect(mapRedmineIssueMock).toHaveBeenCalledWith(rawIssue, 'https://x.example')
    expect(result).toEqual({ id: 1 })
  })
})
