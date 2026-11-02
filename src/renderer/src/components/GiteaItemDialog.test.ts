import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GiteaWorkItemDetails } from '../../../shared/gitea-types'

const gitea = vi.hoisted(() => ({
  workItemDetails: vi.fn(),
  listAssignableUsers: vi.fn(),
  updatePR: vi.fn(),
  updateIssue: vi.fn(),
  updatePRReviewers: vi.fn(),
  closePR: vi.fn(),
  reopenPR: vi.fn(),
  mergePR: vi.fn(),
  addPRInlineComment: vi.fn(),
  resolvePRDiscussion: vi.fn(),
  jobTrace: vi.fn(),
  listLabels: vi.fn(),
  addPRComment: vi.fn(),
  addIssueComment: vi.fn()
}))

vi.mock('@/runtime/gitea-owner-api', () => ({ giteaApiFor: () => gitea }))

import { createGiteaDialogForge } from './gitea-item-dialog/gitea-dialog-forge'
import { giteaItemToDialogItem } from './gitea-item-dialog/gitea-dialog-mappers'

const selector = { repoPath: '/work/app', repoId: 'repo-1' }

const prDetails: GiteaWorkItemDetails = {
  item: {
    id: 'pr:4',
    type: 'pr',
    number: 4,
    title: 'Add thing',
    state: 'open',
    url: 'https://gitea.example/o/r/pulls/4',
    labels: ['feat'],
    updatedAt: '2026-10-01T00:00:00Z',
    author: 'sam'
  },
  body: 'Body',
  comments: [],
  headSha: 'head',
  baseSha: 'base',
  files: [
    { path: 'a.ts', status: 'deleted', additions: 0, deletions: 3, isBinary: false },
    { path: 'b.ts', status: 'added', additions: 1, deletions: 0, isBinary: false }
  ],
  reviewers: [{ id: 11, username: 'rev', name: null, avatarUrl: '' }],
  approvalState: {
    approvedBy: [{ id: 11, username: 'rev', name: null, avatarUrl: '' }],
    changesRequested: false
  },
  pipelineJobs: [
    { id: 9, runId: 2, name: 'build', stage: 'ci', status: 'success', webUrl: 'u', duration: 3 }
  ]
}

beforeEach(() => {
  for (const fn of Object.values(gitea)) {
    fn.mockReset()
  }
})

describe('giteaItemToDialogItem', () => {
  it('presents Gitea PRs and open state in the shared dialog vocabulary', () => {
    expect(giteaItemToDialogItem({ ...prDetails.item, repoId: 'repo-1' })).toMatchObject({
      type: 'mr',
      state: 'opened',
      repoId: 'repo-1',
      number: 4
    })
    expect(
      giteaItemToDialogItem({ ...prDetails.item, type: 'issue', state: 'closed', repoId: 'r' })
    ).toMatchObject({ type: 'issue', state: 'closed' })
  })
})

describe('createGiteaDialogForge', () => {
  it('loads PR details with review data and maps files, jobs, reviewers and refs', async () => {
    gitea.workItemDetails.mockResolvedValue(prDetails)
    const api = createGiteaDialogForge().apiFor(selector)

    const details = await api.workItemDetails({ ...selector, iid: 4, type: 'mr' })

    expect(gitea.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, type: 'pr', includeReviewDetails: true })
    )
    expect(details).toMatchObject({
      headSha: 'head',
      baseSha: 'base',
      startSha: 'base',
      files: [
        expect.objectContaining({ status: 'removed' }),
        expect.objectContaining({ status: 'added' })
      ],
      pipelineJobs: [expect.objectContaining({ id: 9, pipelineId: 2 })],
      reviewers: [expect.objectContaining({ username: 'rev', id: 11 })],
      approvalState: expect.objectContaining({ approvalsLeft: 0 })
    })
    expect(details?.item).toMatchObject({ type: 'mr', state: 'opened', repoId: 'repo-1' })
  })

  it('routes edits to updateIssue for issues and updatePR for PRs', async () => {
    const forge = createGiteaDialogForge()
    const api = forge.apiFor(selector)
    gitea.workItemDetails.mockResolvedValueOnce({
      ...prDetails,
      item: { ...prDetails.item, id: 'issue:5', type: 'issue', number: 5 }
    })
    await api.workItemDetails({ ...selector, iid: 5, type: 'issue' })
    gitea.updateIssue.mockResolvedValue({ ok: true })
    gitea.updatePR.mockResolvedValue({ ok: true })

    await api.updateMR({ ...selector, iid: 5, updates: { title: 'T', addLabels: ['x'] } })
    await api.updateMR({ ...selector, iid: 4, updates: { body: 'B' } })

    expect(gitea.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        number: 5,
        updates: expect.objectContaining({ title: 'T', addLabels: ['x'] })
      })
    )
    expect(gitea.updatePR).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, updates: expect.objectContaining({ body: 'B' }) })
    )
  })

  it('translates reviewer ids back to usernames', async () => {
    const api = createGiteaDialogForge().apiFor(selector)
    gitea.listAssignableUsers.mockResolvedValue([
      { id: 21, username: 'ann', name: 'Ann', avatarUrl: '' }
    ])
    gitea.updatePRReviewers.mockResolvedValue({ ok: true, reviewers: ['ann'] })

    const users = await api.listAssignableUsers(selector)
    const result = await api.updateMRReviewers({
      ...selector,
      iid: 4,
      reviewerIds: users.flatMap((user) => user.id ?? [])
    })

    expect(gitea.updatePRReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, reviewerUsernames: ['ann'] })
    )
    expect(result).toEqual({
      ok: true,
      reviewers: [expect.objectContaining({ username: 'ann', id: 21 })]
    })
  })

  it('maps close, reopen, merge, inline comments, discussion resolution and job logs', async () => {
    const api = createGiteaDialogForge().apiFor(selector)
    for (const fn of [gitea.closePR, gitea.reopenPR, gitea.mergePR, gitea.resolvePRDiscussion]) {
      fn.mockResolvedValue({ ok: true })
    }
    gitea.addPRInlineComment.mockResolvedValue({ ok: true })
    gitea.jobTrace.mockResolvedValue({ ok: true, trace: 'log' })

    await api.closeMR({ ...selector, iid: 4 })
    await api.reopenMR({ ...selector, iid: 4 })
    await api.mergeMR({ ...selector, iid: 4 })
    await api.addMRInlineComment({
      ...selector,
      iid: 4,
      input: { body: 'hi', path: 'a.ts', line: 3, baseSha: 'b', startSha: 's', headSha: 'h' }
    })
    await api.resolveMRDiscussion({ ...selector, iid: 4, discussionId: 'd1', resolved: true })
    const trace = await api.jobTrace({ ...selector, jobId: 9 })

    expect(gitea.closePR).toHaveBeenCalledWith(expect.objectContaining({ number: 4 }))
    expect(gitea.reopenPR).toHaveBeenCalledWith(expect.objectContaining({ number: 4 }))
    expect(gitea.mergePR).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, method: 'merge' })
    )
    expect(gitea.addPRInlineComment).toHaveBeenCalledWith(
      expect.objectContaining({
        number: 4,
        input: { body: 'hi', path: 'a.ts', line: 3, headSha: 'h' }
      })
    )
    expect(gitea.resolvePRDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({ number: 4, discussionId: 'd1', resolved: true })
    )
    expect(gitea.jobTrace).toHaveBeenCalledWith(expect.objectContaining({ jobId: 9 }))
    expect(trace).toEqual({ ok: true, trace: 'log' })
  })

  it('exposes Gitea capabilities to the shared dialog', () => {
    expect(createGiteaDialogForge()).toMatchObject({
      kind: 'gitea',
      canEditIssues: true,
      canRetryJobs: false
    })
  })
})
