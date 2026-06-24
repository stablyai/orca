import { describe, it, expect } from 'vitest'
import { mapGiteaIssueInfo, mapGiteaIssueState, type RawGiteaIssue } from './issue-mappers'

describe('mapGiteaIssueState', () => {
  it('maps closed (case-insensitive)', () => {
    expect(mapGiteaIssueState('closed')).toBe('closed')
    expect(mapGiteaIssueState('CLOSED')).toBe('closed')
    expect(mapGiteaIssueState(' closed ')).toBe('closed')
  })
  it('maps everything else to open', () => {
    expect(mapGiteaIssueState('open')).toBe('open')
    expect(mapGiteaIssueState(null)).toBe('open')
    expect(mapGiteaIssueState(undefined)).toBe('open')
  })
})

describe('mapGiteaIssueInfo', () => {
  const base: RawGiteaIssue = {
    number: 7,
    title: 'Fix the thing',
    state: 'open',
    html_url: 'https://forgejo.example/d1dx/repo/issues/7',
    updated_at: '2026-06-20T00:00:00Z',
    labels: [{ name: 'bug' }, { name: 'p1' }, { name: '' }],
    user: { login: 'daniel', avatar_url: 'https://a/x.png' }
  }

  it('maps an open issue with labels + author (drops empty labels)', () => {
    const r = mapGiteaIssueInfo(base)
    expect(r).not.toBeNull()
    expect(r).toMatchObject({
      number: 7,
      title: 'Fix the thing',
      state: 'open',
      url: base.html_url,
      labels: ['bug', 'p1'],
      author: 'daniel'
    })
  })

  it('maps a closed issue', () => {
    expect(mapGiteaIssueInfo({ ...base, state: 'closed' })?.state).toBe('closed')
  })

  // The critical gotcha (blueprint #1): Gitea's /issues endpoint returns PRs
  // too — they MUST be filtered or PRs leak into the issue list.
  it('returns null for a pull-request entry (pull_request != null)', () => {
    expect(mapGiteaIssueInfo({ ...base, pull_request: {} })).toBeNull()
    expect(mapGiteaIssueInfo({ ...base, pull_request: { merged: false } })).toBeNull()
  })

  it('returns null for malformed records', () => {
    expect(mapGiteaIssueInfo({ ...base, number: undefined })).toBeNull()
    expect(mapGiteaIssueInfo({ ...base, title: '' })).toBeNull()
    expect(mapGiteaIssueInfo({ ...base, html_url: null })).toBeNull()
  })
})
