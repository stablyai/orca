import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const START = 'c'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, WORKSPACE_ID)

describe('mobile web provider inline review comments', () => {
  it('posts a GitHub inline comment only on a freshly retained file and line', async () => {
    const client = inlineClient(githubDetails())
    const result = await mutateInline(client, {
      provider: 'github',
      path: 'src/review.ts',
      line: 12
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('github.addPRReviewComment', {
      repo: 'id:repo-1',
      prNumber: 17,
      commitId: HEAD,
      path: 'src/review.ts',
      line: 12,
      body: 'Keep the host boundary.',
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      reviewNumber: 17,
      action: 'inlineComment',
      expectedReviewHead: HEAD,
      path: 'src/review.ts',
      line: 12,
      outcome: 'completed'
    })
  })

  it('keeps GitLab diff refs and project identity native-only', async () => {
    const client = inlineClient(gitLabDetails(), 'gitlab')
    const review = await executeMobileWebProviderOperation({
      operation: 'review',
      payload: identity(),
      client,
      workspaceAuthority
    })
    expect(review).toMatchObject({
      review: {
        headSha: HEAD,
        files: [
          {
            path: 'src/review.ts',
            oldPath: 'src/old-review.ts',
            commentableLines: [10, 11, 12]
          }
        ]
      }
    })
    expect(JSON.stringify(review)).not.toContain(BASE)
    expect(JSON.stringify(review)).not.toContain(START)
    expect(JSON.stringify(review)).not.toContain('@@')
    expect(JSON.stringify(review)).not.toContain('gitlab.example')

    await mutateInline(client, {
      provider: 'gitlab',
      path: 'src/review.ts',
      line: 11
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('gitlab.addMRInlineComment', {
      repo: 'id:repo-1',
      iid: 17,
      input: {
        body: 'Keep the host boundary.',
        path: 'src/review.ts',
        oldPath: 'src/old-review.ts',
        line: 11,
        baseSha: BASE,
        startSha: START,
        headSha: HEAD
      },
      projectRef: { host: 'gitlab.example', path: 'acme/orca' }
    })
  })

  it('rejects stale heads, unretained paths, and unretained lines before mutation', async () => {
    for (const target of [
      {
        details: githubDetails(),
        expectedReviewHead: 'd'.repeat(40),
        path: 'src/review.ts',
        line: 12
      },
      { details: githubDetails(), expectedReviewHead: HEAD, path: 'src/other.ts', line: 12 },
      { details: githubDetails(), expectedReviewHead: HEAD, path: 'src/review.ts', line: 99 }
    ]) {
      const client = inlineClient(target.details)
      await expect(
        executeMobileWebProviderOperation({
          operation: 'mutateReview',
          payload: {
            ...identity(),
            provider: 'github',
            reviewNumber: 17,
            action: 'inlineComment',
            expectedReviewHead: target.expectedReviewHead,
            path: target.path,
            line: target.line,
            body: 'Reject stale target'
          },
          client,
          workspaceAuthority
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(callsFor(client, 'github.addPRReviewComment')).toHaveLength(0)
    }
  })
})

function mutateInline(
  client: RpcClient,
  target: { provider: 'github' | 'gitlab'; path: string; line: number }
) {
  return executeMobileWebProviderOperation({
    operation: 'mutateReview',
    payload: {
      ...identity(),
      provider: target.provider,
      reviewNumber: 17,
      action: 'inlineComment',
      expectedReviewHead: HEAD,
      path: target.path,
      line: target.line,
      body: 'Keep the host boundary.'
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

function githubDetails() {
  return {
    item: {
      id: 'PR_1',
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
      id: 'mr-17',
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

function inlineClient(
  details: unknown,
  provider: 'github' | 'gitlab' = 'github'
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const sendRequest = vi.fn(async (method: string) => {
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
    if (method === 'github.addPRReviewComment' || method === 'gitlab.addMRInlineComment') {
      return { ok: true, result: { ok: true, comment: { id: 1 } } }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
