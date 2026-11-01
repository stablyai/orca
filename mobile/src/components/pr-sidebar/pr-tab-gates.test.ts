import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../src/shared/github/comment-types'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import { buildPrGateRows } from './pr-tab-gates'

const pr: PRInfo = {
  number: 7,
  title: 'PR',
  state: 'open',
  url: 'https://example.test/7',
  checksStatus: 'pending',
  updatedAt: '',
  mergeable: 'MERGEABLE',
  baseRefName: 'main'
}

function details(over: Partial<GitHubWorkItemDetails['item']>, comments: PRComment[] = []) {
  return {
    item: {
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'PR',
      state: 'open',
      url: '',
      labels: [],
      updatedAt: '',
      author: 'me',
      ...over
    },
    body: '',
    comments
  } satisfies GitHubWorkItemDetails
}

function comment(over: Partial<PRComment>): PRComment {
  return { id: 1, author: 'a', authorAvatarUrl: '', body: '', createdAt: '', url: '', ...over }
}

function gate(rows: ReturnType<typeof buildPrGateRows>, key: string) {
  return rows.find((row) => row.key === key)
}

describe('buildPrGateRows', () => {
  it('names failing checks and routes them to the Checks screen', () => {
    const rows = buildPrGateRows({
      pr,
      details: details({}),
      checksError: null,
      checks: [
        { name: 'lint', status: 'completed', conclusion: 'success', url: null },
        { name: 'test (windows)', status: 'completed', conclusion: 'failure', url: null }
      ]
    })
    expect(gate(rows, 'checks')).toMatchObject({
      tone: 'blocking',
      title: '1 check failing',
      subtitle: 'test (windows)',
      target: 'checks'
    })
  })

  it('counts unresolved threads once each and calls out bots', () => {
    const rows = buildPrGateRows({
      pr,
      checks: [],
      checksError: null,
      details: details({}, [
        comment({
          id: 1,
          author: 'nwparker',
          path: 'src/Banner.tsx',
          threadId: 't1',
          isResolved: false
        }),
        comment({ id: 2, author: 'me', threadId: 't1', isResolved: false }),
        comment({
          id: 3,
          author: 'coderabbitai[bot]',
          threadId: 't2',
          isResolved: false,
          isBot: true
        }),
        comment({ id: 4, author: 'x', threadId: 't3', isResolved: true })
      ])
    })
    expect(gate(rows, 'threads')).toMatchObject({
      tone: 'waiting',
      title: '2 unresolved threads',
      subtitle: 'nwparker on Banner.tsx · 1 from a bot'
    })
  })

  it('blocks on requested changes and waits on a required review without a required count', () => {
    const blocked = buildPrGateRows({
      pr,
      checks: [],
      checksError: null,
      details: details({
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: [{ login: 'jinwoo', state: 'CHANGES_REQUESTED' }]
      })
    })
    expect(gate(blocked, 'approvals')).toMatchObject({
      tone: 'blocking',
      subtitle: 'jinwoo requested changes',
      target: 'reviewers'
    })
    const waiting = buildPrGateRows({
      pr,
      checks: [],
      checksError: null,
      details: details({
        reviewDecision: 'REVIEW_REQUIRED',
        latestReviews: [{ login: 'jinwoo', state: 'APPROVED' }],
        reviewRequests: [{ login: 'brennanb', name: null, avatarUrl: '' }]
      })
    })
    expect(gate(waiting, 'approvals')).toMatchObject({
      tone: 'waiting',
      title: '1 approval',
      subtitle: 'jinwoo approved · brennanb requested'
    })
  })

  it('shows loading rather than "no threads" while details are still on the way', () => {
    const rows = buildPrGateRows({ pr, checks: [], checksError: null, details: null })
    expect(gate(rows, 'threads')?.tone).toBe('loading')
    expect(gate(rows, 'approvals')?.tone).toBe('loading')
  })

  it('reports conflicts against the base branch', () => {
    const rows = buildPrGateRows({
      pr: { ...pr, mergeable: 'CONFLICTING' },
      checks: [],
      checksError: null,
      details: details({})
    })
    expect(gate(rows, 'conflicts')).toMatchObject({
      tone: 'blocking',
      title: 'Conflicts with main'
    })
  })

  it('counts an approval gate as failing and waits for GitHub before calling conflicts clear', () => {
    const rows = buildPrGateRows({
      pr: { ...pr, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      checks: [{ name: 'deploy', status: 'completed', conclusion: 'action_required', url: null }],
      checksError: null,
      details: details({})
    })
    expect(gate(rows, 'checks')).toMatchObject({ tone: 'blocking', subtitle: 'deploy' })
    expect(gate(rows, 'conflicts')).toMatchObject({ tone: 'idle', title: 'Checking for conflicts' })
  })

  it('does not count neutral checks as passed', () => {
    const rows = buildPrGateRows({
      pr,
      checks: [
        { name: 'lint', status: 'completed', conclusion: 'success', url: null },
        { name: 'docs', status: 'completed', conclusion: 'neutral', url: null }
      ],
      checksError: null,
      details: details({})
    })
    expect(gate(rows, 'checks')).toMatchObject({
      tone: 'passed',
      title: '1 check passed',
      subtitle: '1 neutral'
    })
  })
})
