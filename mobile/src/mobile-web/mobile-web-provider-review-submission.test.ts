import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const START = 'c'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, WORKSPACE_ID)

describe('mobile web provider review submission', () => {
  it('atomically submits GitHub verdict and queued comments through native-only identity', async () => {
    const client = submissionClient(githubDetails(), 'github')
    const result = await submit(client, {
      provider: 'github',
      action: 'request-changes',
      summary: 'Please address this.',
      comments: [queuedComment(12)]
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('hostedReview.submit', {
      repo: 'id:repo-1',
      provider: 'github',
      number: 17,
      expectedHead: HEAD,
      action: 'request-changes',
      summary: 'Please address this.',
      comments: [{ path: 'src/review.ts', line: 12, body: 'Queued comment' }],
      repository: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 17,
      expectedReviewHead: HEAD,
      submissionId: 'submission_1234567890',
      action: 'request-changes',
      submittedCommentIds: ['comment_1234567890'],
      outcome: 'completed'
    })
    expect(JSON.stringify(result)).not.toContain('github.example')
  })

  it('submits GitLab queued discussions with native-only project and diff refs', async () => {
    const client = submissionClient(gitLabDetails(), 'gitlab')
    const result = await submit(client, {
      provider: 'gitlab',
      action: 'comment',
      summary: 'Summary',
      comments: [queuedComment(11)]
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('hostedReview.submit', {
      repo: 'id:repo-1',
      provider: 'gitlab',
      number: 17,
      expectedHead: HEAD,
      action: 'comment',
      summary: 'Summary',
      comments: [
        {
          path: 'src/review.ts',
          oldPath: 'src/old-review.ts',
          line: 11,
          body: 'Queued comment'
        }
      ],
      projectRef: { host: 'gitlab.example', path: 'acme/orca' },
      baseSha: BASE,
      startSha: START
    })
    expect(JSON.stringify(result)).not.toContain(BASE)
    expect(JSON.stringify(result)).not.toContain('gitlab.example')
  })

  it('rejects stale heads, unretained lines, and unsupported GitLab verdicts before submission', async () => {
    for (const candidate of [
      {
        provider: 'github' as const,
        details: githubDetails(),
        expectedReviewHead: 'd'.repeat(40),
        action: 'comment' as const,
        line: 12
      },
      {
        provider: 'github' as const,
        details: githubDetails(),
        expectedReviewHead: HEAD,
        action: 'comment' as const,
        line: 99
      },
      {
        provider: 'gitlab' as const,
        details: gitLabDetails(),
        expectedReviewHead: HEAD,
        action: 'approve' as const,
        line: 11
      }
    ]) {
      const client = submissionClient(candidate.details, candidate.provider)
      await expect(
        executeMobileWebProviderOperation({
          operation: 'submitReview',
          payload: {
            ...identity(),
            provider: candidate.provider,
            reviewNumber: 17,
            expectedReviewHead: candidate.expectedReviewHead,
            submissionId: 'submission_1234567890',
            action: candidate.action,
            summary: candidate.action === 'approve' ? '' : 'Summary',
            comments: candidate.action === 'approve' ? [] : [queuedComment(candidate.line)]
          },
          client,
          workspaceAuthority
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(callsFor(client, 'hostedReview.submit')).toHaveLength(0)
    }
  })

  it('maps provider action and count mismatches to a stable broker error', async () => {
    for (const providerResult of [
      { ok: true, result: { ok: true, action: 'approve', submittedComments: 1 } },
      { ok: true, result: { ok: true, action: 'comment', submittedComments: 0 } },
      {
        ok: false,
        error: { message: 'https://github.example/private provider target failed' }
      }
    ]) {
      const client = submissionClient(githubDetails(), 'github', providerResult)
      const error = await submit(client, {
        provider: 'github',
        action: 'comment',
        summary: '',
        comments: [queuedComment(12)]
      }).catch((submissionError: unknown) => submissionError)

      expect(error).toMatchObject({ code: 'host_error' })
      expect(JSON.stringify(error)).not.toContain('github.example')
    }
  })
})

function submit(
  client: RpcClient,
  input: {
    provider: 'github' | 'gitlab'
    action: 'comment' | 'approve' | 'request-changes'
    summary: string
    comments: ReturnType<typeof queuedComment>[]
  }
) {
  return executeMobileWebProviderOperation({
    operation: 'submitReview',
    payload: {
      ...identity(),
      provider: input.provider,
      reviewNumber: 17,
      expectedReviewHead: HEAD,
      submissionId: 'submission_1234567890',
      action: input.action,
      summary: input.summary,
      comments: input.comments
    },
    client,
    workspaceAuthority
  })
}

function identity() {
  return {
    workspaceId: WORKSPACE_ID,
    expectedHead: HEAD,
    expectedBranch: 'feature/review'
  }
}

function queuedComment(line: number) {
  return {
    id: 'comment_1234567890',
    path: 'src/review.ts',
    line,
    body: 'Queued comment'
  }
}

function githubDetails() {
  return {
    item: {
      number: 17,
      type: 'pr',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    },
    body: '',
    comments: [],
    headSha: HEAD,
    baseSha: BASE,
    files: [
      {
        path: 'src/review.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        isBinary: false,
        reviewCommentLineNumbers: [12, 13]
      }
    ]
  }
}

function gitLabDetails() {
  return {
    item: {
      number: 17,
      type: 'mr',
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    },
    body: '',
    comments: [],
    headSha: HEAD,
    baseSha: BASE,
    startSha: START,
    files: [
      {
        path: 'src/review.ts',
        oldPath: 'src/old-review.ts',
        status: 'renamed',
        additions: 1,
        deletions: 0,
        isBinary: false,
        diff: '@@ -10,2 +10,3 @@\n context\n+new line\n next context'
      }
    ]
  }
}

function submissionClient(
  details: unknown,
  provider: 'github' | 'gitlab',
  submissionResponse?: unknown
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn(async (method: string, params: unknown) => {
    if (method === 'git.status') {
      return {
        ok: true,
        result: { head: HEAD, branch: 'feature/review', conflictOperation: 'unknown' }
      }
    }
    if (method === 'hostedReview.forBranch') {
      return {
        ok: true,
        result: {
          provider,
          number: 17,
          title: 'Provider review',
          state: 'open',
          status: 'success',
          updatedAt: '2026-07-23T00:00:00.000Z',
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          headSha: HEAD
        }
      }
    }
    if (method === 'github.workItemDetails' || method === 'gitlab.workItemDetails') {
      return { ok: true, result: details }
    }
    if (method === 'hostedReview.submit') {
      if (submissionResponse) {
        return submissionResponse
      }
      const input = params as { action: string; comments: unknown[] }
      return {
        ok: true,
        result: { ok: true, action: input.action, submittedComments: input.comments.length }
      }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
