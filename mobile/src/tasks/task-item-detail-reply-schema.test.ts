import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  githubAssignableUsersSchema,
  githubRepoLabelsSchema,
  githubWorkItemDetailSchema,
  gitlabWorkItemDetailSchema,
  linearIssueCommentsSchema,
  linearIssueSchema,
  linearTeamStatesSchema,
  linearTeamsSchema
} from './task-item-detail-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

const LINEAR_ISSUE = {
  id: 'issue-2',
  identifier: 'ENG-2',
  title: 'A sub-issue',
  url: '',
  description: 'a description',
  state: { name: 'Todo', type: 'unstarted', color: '#000' },
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  labels: [],
  priority: 0,
  updatedAt: '2020-01-01T00:00:00.000Z',
  workspaceId: 'linear-workspace',
  subIssues: []
}

describe('the GitHub detail pane', () => {
  it('reads the recorded reply and keeps every member the sheet reads behind a guard', () => {
    const details = reads(githubWorkItemDetailSchema, {
      body: 'body',
      comments: [],
      item: { labels: ['bug'], reviewDecision: 'APPROVED', reviewRequests: [], latestReviews: [] },
      assignees: ['octocat'],
      headSha: 'head-sha',
      baseSha: 'base-sha',
      pullRequestId: 'PR_kwDO',
      checks: [],
      files: []
    })
    expect(details).toMatchObject({ body: 'body', headSha: 'head-sha', assignees: ['octocat'] })
    expect(details?.item?.reviewDecision).toBe('APPROVED')
  })

  it('answers null for the null the host sends, and names anything that is not the container', () => {
    expect(reads(githubWorkItemDetailSchema, null)).toBeNull()
    expect(refuses(githubWorkItemDetailSchema, 'nothing here')).toBe(true)
    expect(refuses(githubWorkItemDetailSchema, 7)).toBe(true)
  })

  it('keeps an explicit reviewDecision null, which the call site falls back from itself', () => {
    const details = reads(githubWorkItemDetailSchema, { item: { reviewDecision: null } })
    expect(details?.item?.reviewDecision).toBeNull()
  })

  it('requires nothing inside, because the sheet reads every member behind ?? or ?.', () => {
    expect(reads(githubWorkItemDetailSchema, {})).toEqual({})
  })
})

describe('the GitLab detail pane', () => {
  it('reads the recorded reply, approval state and pipeline jobs included', () => {
    const details = reads(gitlabWorkItemDetailSchema, {
      body: 'body',
      comments: [],
      item: { labels: ['bug'], mergeable: 'MERGEABLE' },
      assignees: [],
      pipelineJobs: [],
      reviewers: [],
      approvalState: { approvalsRequired: 1, approvalsLeft: 0 }
    })
    expect(details?.item?.mergeable).toBe('MERGEABLE')
    expect(details?.approvalState).toEqual({ approvalsRequired: 1, approvalsLeft: 0 })
  })

  it('carries every mergeable arm and degrades one it has not heard of to absent', () => {
    for (const mergeable of ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']) {
      expect(reads(gitlabWorkItemDetailSchema, { item: { mergeable } })?.item?.mergeable).toBe(
        mergeable
      )
    }
    expect(
      reads(gitlabWorkItemDetailSchema, { item: { mergeable: 'BLOCKED' } })?.item?.mergeable
    ).toBeUndefined()
  })

  it('keeps an explicit null approval count, which the reviewDecision ladder reads', () => {
    const details = reads(gitlabWorkItemDetailSchema, {
      approvalState: { approvalsRequired: null, approvalsLeft: null }
    })
    expect(details?.approvalState).toEqual({ approvalsRequired: null, approvalsLeft: null })
  })

  it('drops a pipeline job the summary could not classify', () => {
    const jobs = reads(gitlabWorkItemDetailSchema, {
      pipelineJobs: [
        { id: 1, name: 'build', stage: 'build', status: 'success', webUrl: null, duration: null },
        { id: 2, stage: 'test', status: 'failed' }
      ]
    })?.pipelineJobs
    expect(jobs).toHaveLength(1)
    expect(jobs?.[0]).toMatchObject({ name: 'build', duration: null })
  })
})

describe('one Linear issue', () => {
  it('reads the recorded reply whole', () => {
    expect(reads(linearIssueSchema, LINEAR_ISSUE)).toMatchObject({ id: 'issue-2', priority: 0 })
  })

  it('answers null for the null getIssue sends when the workspace cannot see the issue', () => {
    expect(reads(linearIssueSchema, null)).toBeNull()
  })

  it('refuses a reply missing a member createLinearTask reads with no guard', () => {
    for (const key of ['id', 'identifier', 'title', 'updatedAt', 'url', 'priority', 'labels']) {
      const partial: Record<string, unknown> = { ...LINEAR_ISSUE }
      delete partial[key]
      expect(refuses(linearIssueSchema, partial)).toBe(true)
    }
    expect(refuses(linearIssueSchema, { ...LINEAR_ISSUE, team: { id: 't', key: 'ENG' } })).toBe(
      true
    )
    expect(refuses(linearIssueSchema, { ...LINEAR_ISSUE, state: { type: 'x', color: '#0' } })).toBe(
      true
    )
  })

  it('keeps an explicit estimate null, which is the host own "no estimate"', () => {
    expect(reads(linearIssueSchema, { ...LINEAR_ISSUE, estimate: null })?.estimate).toBeNull()
    expect(reads(linearIssueSchema, { ...LINEAR_ISSUE, estimate: 3 })?.estimate).toBe(3)
    expect(reads(linearIssueSchema, LINEAR_ISSUE)?.estimate).toBeUndefined()
  })

  it('drops a sub-issue row the children list could not open', () => {
    const withChildren = {
      ...LINEAR_ISSUE,
      subIssues: [
        { id: 'c-1', identifier: 'ENG-9', title: 'child', url: 'https://linear.app/x' },
        { id: 'c-2', identifier: 'ENG-10' }
      ]
    }
    expect(reads(linearIssueSchema, withChildren)?.subIssues).toHaveLength(1)
  })

  it('drops a label element that is not text rather than failing the sheet', () => {
    expect(reads(linearIssueSchema, { ...LINEAR_ISSUE, labels: ['bug', 7] })?.labels).toEqual([
      'bug'
    ])
  })
})

describe('the lists beside the sheet', () => {
  it('reads a comment list, and reads nullish as the empty list the call site already read', () => {
    expect(
      reads(linearIssueCommentsSchema, [
        { id: 'comment-1', body: 'a comment', createdAt: '2020-01-01T00:00:00.000Z' }
      ])
    ).toHaveLength(1)
    expect(reads(linearIssueCommentsSchema, null)).toBeNull()
    expect(reads(linearIssueCommentsSchema, undefined)).toBeUndefined()
    expect(refuses(linearIssueCommentsSchema, 'none')).toBe(true)
  })

  it('reads the label vocabulary and drops an element that is not a chip', () => {
    expect(reads(githubRepoLabelsSchema, ['bug', 'chore'])).toEqual(['bug', 'chore'])
    expect(reads(githubRepoLabelsSchema, ['bug', { name: 'chore' }])).toEqual(['bug'])
    expect(refuses(githubRepoLabelsSchema, { labels: [] })).toBe(true)
  })

  it('reads the recorded assignable users with their null avatar intact', () => {
    expect(
      reads(githubAssignableUsersSchema, [{ login: 'octocat', name: 'Octo', avatarUrl: null }])
    ).toEqual([{ login: 'octocat', name: 'Octo', avatarUrl: null }])
  })

  it('requires a workflow state id, name and type, and leaves colour to the call site', () => {
    expect(
      reads(linearTeamStatesSchema, [{ id: 'state-1', name: 'Todo', type: 'unstarted' }])
    ).toHaveLength(1)
    expect(reads(linearTeamStatesSchema, [{ id: 'state-1', name: 'Todo' }])).toEqual([])
  })

  it('requires a team id, name and key, which both team readers depend on', () => {
    expect(
      reads(linearTeamsSchema, [
        { id: 'team-1', key: 'ENG', name: 'Engineering', workspaceId: 'linear-workspace' }
      ])
    ).toHaveLength(1)
    expect(reads(linearTeamsSchema, [{ id: 'team-1', name: 'Engineering' }])).toEqual([])
    expect(refuses(linearTeamsSchema, null)).toBe(true)
  })
})
