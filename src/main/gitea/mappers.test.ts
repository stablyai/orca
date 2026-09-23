import { describe, expect, it } from 'vitest'
import { isGiteaPullRequest, mapGiteaComment, mapGiteaIssue, mapGiteaUser } from './mappers'

const context = { owner: 'team', repo: 'app', serverId: 'srv1', serverName: 'git.example.com' }

describe('gitea mappers', () => {
  it('detects pull requests returned by the issues endpoint', () => {
    expect(isGiteaPullRequest({ pull_request: { merged: false } })).toBe(true)
    expect(isGiteaPullRequest({ pull_request: null })).toBe(false)
    expect(isGiteaPullRequest({})).toBe(false)
  })

  it('maps a raw issue into the shared shape', () => {
    const issue = mapGiteaIssue(
      {
        id: 10,
        number: 4,
        title: '  Fix login  ',
        body: 'Steps to repro',
        state: 'open',
        html_url: 'https://git.example.com/team/app/issues/4',
        user: { id: 1, login: 'octo', full_name: 'Octo Cat' },
        labels: [
          { id: 2, name: 'bug' },
          { id: 3, name: '' }
        ],
        assignees: [{ id: 5, login: 'dev' }],
        milestone: { title: 'v1' },
        comments: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z'
      },
      context
    )
    expect(issue).toEqual({
      id: 10,
      number: 4,
      serverId: 'srv1',
      serverName: 'git.example.com',
      repoOwner: 'team',
      repoName: 'app',
      title: 'Fix login',
      body: 'Steps to repro',
      state: 'open',
      url: 'https://git.example.com/team/app/issues/4',
      labels: ['bug'],
      assignees: [{ id: 5, login: 'dev' }],
      author: { id: 1, login: 'octo', fullName: 'Octo Cat' },
      milestone: 'v1',
      comments: 2,
      updatedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z'
    })
  })

  it('returns null when identifiers are missing', () => {
    expect(mapGiteaIssue({ number: 4 }, context)).toBeNull()
    expect(mapGiteaIssue({ id: 10 }, context)).toBeNull()
  })

  it('treats unknown states as open and drops invalid users', () => {
    const issue = mapGiteaIssue({ id: 1, number: 1, state: 'weird', user: {} }, context)
    expect(issue?.state).toBe('open')
    expect(issue?.author).toBeUndefined()
  })

  it('maps comments and skips those without an id', () => {
    expect(mapGiteaComment({ id: 7, body: 'hi', created_at: '2026-01-01T00:00:00Z' })).toEqual({
      id: 7,
      body: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: undefined,
      user: undefined
    })
    expect(mapGiteaComment({ body: 'no id' })).toBeNull()
  })

  it('requires id and login to map a user', () => {
    expect(mapGiteaUser({ id: 1, login: 'octo' })).toEqual({
      id: 1,
      login: 'octo',
      fullName: undefined,
      avatarUrl: undefined
    })
    expect(mapGiteaUser({ login: 'octo' })).toBeUndefined()
    expect(mapGiteaUser(null)).toBeUndefined()
  })
})
