import { describe, expect, it } from 'vitest'
import { toYouTrackComment, toYouTrackIssue } from './issue-mapping'
import { normalizeYouTrackBaseUrl, youtrackBaseUrlCandidates } from './youtrack-request'

const BASE_URL = 'https://yt.example.com/youtrack'

function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '2-17',
    idReadable: 'APP-17',
    summary: 'Fix login redirect',
    created: 1_700_000_000_000,
    updated: 1_700_000_500_000,
    resolved: null,
    project: { id: '0-2', shortName: 'APP', name: 'Application' },
    reporter: { id: '1-1', login: 'jane', fullName: 'Jane Doe', avatarUrl: '/hub/avatar/1' },
    tags: [{ name: 'backend', color: { background: '#fff', foreground: '#000' } }],
    customFields: [
      {
        $type: 'StateMachineIssueCustomField',
        name: 'Stage',
        value: { name: 'In Progress', isResolved: false, color: { background: '#00f' } }
      },
      {
        $type: 'SingleUserIssueCustomField',
        name: 'Assignee',
        value: { login: 'me', fullName: 'Me' }
      },
      { $type: 'SingleEnumIssueCustomField', name: 'Priority', value: { name: 'Major' } },
      { $type: 'SingleEnumIssueCustomField', name: 'Type', value: { name: 'Bug' } },
      { $type: 'DateIssueCustomField', name: 'Due Date', value: Date.UTC(2026, 9, 31) },
      {
        $type: 'MultiVersionIssueCustomField',
        name: 'Fix versions',
        value: [{ name: '1.0' }, { name: '1.1' }]
      }
    ],
    links: [
      {
        direction: 'OUTWARD',
        linkType: {
          name: 'Depend',
          sourceToTarget: 'is required for',
          targetToSource: 'depends on'
        },
        issues: [{ id: '2-30', idReadable: 'APP-30', summary: 'Later', resolved: null }]
      },
      {
        direction: 'INWARD',
        linkType: {
          name: 'Depend',
          sourceToTarget: 'is required for',
          targetToSource: 'depends on'
        },
        issues: [
          { id: '2-5', idReadable: 'APP-5', summary: 'Auth API', resolved: null },
          { id: '2-6', idReadable: 'APP-6', summary: 'Done already', resolved: 1_700_000_000_000 }
        ]
      },
      {
        direction: 'BOTH',
        linkType: { name: 'Relates', sourceToTarget: 'relates to', targetToSource: 'relates to' },
        issues: []
      }
    ],
    ...overrides
  }
}

describe('toYouTrackIssue', () => {
  it('lifts state, assignee, priority, and type out of custom fields', () => {
    const issue = toYouTrackIssue(rawIssue(), BASE_URL)
    expect(issue).toMatchObject({
      idReadable: 'APP-17',
      url: 'https://yt.example.com/youtrack/issue/APP-17',
      state: { name: 'In Progress', isResolved: false },
      stateFieldName: 'Stage',
      assignee: { login: 'me', fullName: 'Me' },
      priority: 'Major',
      type: 'Bug',
      resolved: false
    })
    expect(issue?.fields).toEqual([
      { name: 'Stage', value: 'In Progress', raw: ['In Progress'] },
      { name: 'Assignee', value: 'Me', raw: ['me'] },
      { name: 'Priority', value: 'Major', raw: ['Major'] },
      { name: 'Type', value: 'Bug', raw: ['Bug'] },
      { name: 'Due Date', value: '2026-10-31', raw: ['2026-10-31'] },
      { name: 'Fix versions', value: '1.0, 1.1', raw: ['1.0', '1.1'] }
    ])
    expect(issue?.reporter?.avatarUrl).toBe('https://yt.example.com/hub/avatar/1')
  })

  it('groups links with blockers first and counts unresolved blockers', () => {
    const issue = toYouTrackIssue(rawIssue(), BASE_URL)
    expect(issue?.links.map((group) => [group.label, group.blocking])).toEqual([
      ['depends on', 'blocked-by'],
      ['is required for', 'blocks']
    ])
    expect(issue?.unresolvedBlockerCount).toBe(1)
  })

  it('rejects payloads without a readable id', () => {
    expect(toYouTrackIssue({ id: '1' }, BASE_URL)).toBeNull()
    expect(toYouTrackIssue(null, BASE_URL)).toBeNull()
  })
})

describe('toYouTrackComment', () => {
  it('drops deleted comments', () => {
    expect(toYouTrackComment({ id: 'c1', text: 'x', deleted: true }, BASE_URL)).toBeNull()
    expect(toYouTrackComment({ id: 'c2', text: 'hello', created: 0 }, BASE_URL)).toMatchObject({
      id: 'c2',
      text: 'hello'
    })
  })
})

describe('normalizeYouTrackBaseUrl', () => {
  it('keeps path prefixes but strips pasted UI and API suffixes', () => {
    expect(normalizeYouTrackBaseUrl('yt.example.com')).toBe('https://yt.example.com')
    expect(normalizeYouTrackBaseUrl('https://example.com/youtrack/')).toBe(
      'https://example.com/youtrack'
    )
    expect(normalizeYouTrackBaseUrl('https://example.com/youtrack/issue/APP-1')).toBe(
      'https://example.com/youtrack'
    )
    expect(normalizeYouTrackBaseUrl('https://yt.example.com/api/issues')).toBe(
      'https://yt.example.com'
    )
    expect(normalizeYouTrackBaseUrl('https://corp.example.com/projects/yt/issue/APP-1')).toBe(
      'https://corp.example.com/projects/yt'
    )
  })

  it('offers the path as entered when trimming could have cut a real mount path', () => {
    expect(youtrackBaseUrlCandidates('https://corp.example.com/projects/yt')).toEqual([
      'https://corp.example.com',
      'https://corp.example.com/projects/yt'
    ])
    expect(youtrackBaseUrlCandidates('https://yt.example.com/youtrack/')).toEqual([
      'https://yt.example.com/youtrack'
    ])
  })
})
