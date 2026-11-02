import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonMock, resolveGiteaIssueSourceMock, runGiteaTeaCommandMock } = vi.hoisted(
  () => ({
    requestGiteaJsonMock: vi.fn(),
    resolveGiteaIssueSourceMock: vi.fn(),
    runGiteaTeaCommandMock: vi.fn()
  })
)

vi.mock('./pull-request-mutation-transport', () => ({
  directGiteaApiToken: () => null,
  giteaAuthRequiredResult: () => ({ ok: false, error: 'auth required' }),
  giteaWriteUsesTea: (r: { loginName?: string }) => Boolean(r.loginName),
  runGiteaTeaCommand: runGiteaTeaCommandMock,
  writeGiteaJson: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

import { listGiteaNotifications, markGiteaNotificationRead } from './notifications'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

describe('listGiteaNotifications', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
  })

  it('maps unread issue and pull notifications to work-item references', async () => {
    requestGiteaJsonMock.mockResolvedValue([
      {
        id: 11,
        unread: true,
        updated_at: '2026-05-02T00:00:00Z',
        repository: { full_name: 'team/widgets' },
        subject: {
          title: 'Broken widget',
          type: 'Issue',
          html_url: 'https://git.example.com/team/widgets/issues/7',
          state: 'open'
        }
      },
      {
        id: 12,
        unread: true,
        updated_at: '2026-05-03T00:00:00Z',
        repository: { full_name: 'other/lib' },
        subject: {
          title: 'Add widget',
          type: 'Pull',
          url: 'https://git.example.com/api/v1/repos/other/lib/pulls/4',
          html_url: 'https://git.example.com/other/lib/pulls/4'
        }
      },
      {
        id: 13,
        unread: true,
        updated_at: '2026-05-04T00:00:00Z',
        repository: { full_name: 'team/widgets' },
        subject: {
          title: 'abc',
          type: 'Commit',
          html_url: 'https://git.example.com/team/widgets/commit/abc'
        }
      }
    ])

    await expect(listGiteaNotifications('/repo', 'conn-1', {})).resolves.toEqual([
      {
        id: 11,
        subjectType: 'Issue',
        subjectTitle: 'Broken widget',
        subjectUrl: 'https://git.example.com/team/widgets/issues/7',
        subjectNumber: 7,
        repositoryPath: 'team/widgets',
        updatedAt: '2026-05-02T00:00:00Z',
        unread: true
      },
      {
        id: 12,
        subjectType: 'Pull',
        subjectTitle: 'Add widget',
        subjectUrl: 'https://git.example.com/other/lib/pulls/4',
        subjectNumber: 4,
        repositoryPath: 'other/lib',
        updatedAt: '2026-05-03T00:00:00Z',
        unread: true
      },
      {
        id: 13,
        subjectType: 'Commit',
        subjectTitle: 'abc',
        subjectUrl: 'https://git.example.com/team/widgets/commit/abc',
        subjectNumber: null,
        repositoryPath: 'team/widgets',
        updatedAt: '2026-05-04T00:00:00Z',
        unread: true
      }
    ])
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(repo, '/notifications', {
      searchParams: { 'status-types': 'unread', limit: 50 }
    })
  })

  it('returns an empty list when the repository cannot be resolved', async () => {
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: null, fellBack: false })

    await expect(listGiteaNotifications('/repo')).resolves.toEqual([])
    expect(requestGiteaJsonMock).not.toHaveBeenCalled()
  })
})

describe('markGiteaNotificationRead', () => {
  beforeEach(() => {
    runGiteaTeaCommandMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
  })

  it('marks the thread read through tea', async () => {
    runGiteaTeaCommandMock.mockResolvedValue({ ok: true, stdout: '' })

    await expect(markGiteaNotificationRead('/repo', 11)).resolves.toEqual({ ok: true })
    expect(runGiteaTeaCommandMock.mock.calls[0][0].slice(0, 4)).toEqual([
      'api',
      '-X',
      'PATCH',
      '/notifications/threads/11?to-status=read'
    ])
  })

  it('surfaces tea failures and rejects invalid ids', async () => {
    runGiteaTeaCommandMock.mockResolvedValue({ ok: false, error: 'boom' })

    await expect(markGiteaNotificationRead('/repo', 11)).resolves.toEqual({
      ok: false,
      error: 'boom'
    })
    await expect(markGiteaNotificationRead('/repo', 0)).resolves.toMatchObject({ ok: false })
  })
})
