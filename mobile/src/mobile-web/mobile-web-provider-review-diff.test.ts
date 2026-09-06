import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebProviderReviewDiff } from './mobile-web-provider-review-diff'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const WORKSPACE_ID = 'repo-1::/workspace'
const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(WORKSPACE_ID, WORKSPACE_ID)

function executeReviewDiff(input: unknown, client: RpcClient) {
  return executeMobileWebProviderReviewDiff(input, client, workspaceAuthority)
}

describe('mobile web provider review diff', () => {
  it('loads a bounded GitHub page with native-only repository and ref identity', async () => {
    const details = githubDetails()
    const client = reviewDiffClient({
      provider: 'github',
      details,
      contents: {
        original: 'one\nold\nthree\n',
        modified: 'one\nnew\nthree\n',
        originalIsBinary: false,
        modifiedIsBinary: false,
        secret: 'raw-content-secret'
      }
    })
    const result = await executeReviewDiff({ ...payload('github'), limit: 2 }, client)

    expect(client.sendRequest).toHaveBeenLastCalledWith('github.prFileContents', {
      repo: 'id:repo-1',
      prNumber: 17,
      path: 'src/review.ts',
      status: 'modified',
      headSha: HEAD,
      baseSha: BASE,
      prRepo: { host: 'github.example', owner: 'acme', repo: 'orca' }
    })
    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'feature/review',
      provider: 'github',
      reviewNumber: 17,
      reviewHead: HEAD,
      path: 'src/review.ts',
      kind: 'text',
      offset: 0,
      totalRows: 4,
      nextOffset: 2
    })
    expect(JSON.stringify(result)).not.toContain('github.example')
    expect(JSON.stringify(result)).not.toContain('raw-content-secret')
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(128 * 1024)
  })

  it('revalidates review head, retained path, and page revision before returning content', async () => {
    const client = reviewDiffClient({
      provider: 'github',
      details: githubDetails(),
      contents: {
        original: 'old',
        modified: 'new',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    })
    await expect(
      executeReviewDiff({ ...payload('github'), expectedReviewHead: 'c'.repeat(40) }, client)
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      executeReviewDiff({ ...payload('github'), path: 'src/not-retained.ts' }, client)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(client, 'github.prFileContents')).toHaveLength(0)

    const first = await executeReviewDiff(payload('github'), client)
    if (first.kind !== 'text') {
      throw new Error('Expected text diff')
    }
    await expect(
      executeReviewDiff(
        {
          ...payload('github'),
          offset: first.nextOffset ?? 1,
          expectedRevision: 'd'.repeat(64)
        },
        client
      )
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('parses a fresh GitLab patch natively and anchors a thread line without returning raw refs', async () => {
    const patch = [
      '@@ -1,130 +1,130 @@',
      ...Array.from({ length: 130 }, (_, index) =>
        index === 119 ? '+focused line' : ` context ${index + 1}`
      )
    ].join('\n')
    const client = reviewDiffClient({
      provider: 'gitlab',
      details: gitLabDetails(patch)
    })
    const result = await executeReviewDiff(
      { ...payload('gitlab'), focusLine: 120, limit: 20 },
      client
    )

    expect(result).toMatchObject({
      kind: 'text',
      provider: 'gitlab',
      offset: 109,
      focusLine: 120,
      focusRowIndex: 119
    })
    if (result.kind !== 'text') {
      throw new Error('Expected text diff')
    }
    expect(result.rows.find((row) => row.index === result.focusRowIndex)?.text).toBe('focused line')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('@@ -1,130')
    expect(serialized).not.toContain(BASE)
    expect(serialized).not.toContain('gitlab.example')
    expect(callsFor(client, 'github.prFileContents')).toHaveLength(0)
  })

  it('rejects a requested focus line that is absent from the fresh provider diff', async () => {
    const client = reviewDiffClient({
      provider: 'gitlab',
      details: gitLabDetails('@@ -1 +1 @@\n-old\n+new')
    })
    await expect(
      executeReviewDiff({ ...payload('gitlab'), focusLine: 99 }, client)
    ).rejects.toMatchObject({ code: 'conflict' })
  })
})

function payload(provider: 'github' | 'gitlab') {
  return {
    workspaceId: WORKSPACE_ID,
    expectedHead: HEAD,
    expectedBranch: 'feature/review',
    provider,
    reviewNumber: 17,
    expectedReviewHead: HEAD,
    path: 'src/review.ts',
    offset: 0,
    limit: 96
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
        additions: 1,
        deletions: 1,
        isBinary: false,
        reviewCommentLineNumbers: [2]
      }
    ]
  }
}

function gitLabDetails(diff: string) {
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
    startSha: 'c'.repeat(40),
    files: [
      {
        path: 'src/review.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        diff
      }
    ]
  }
}

function reviewDiffClient(options: {
  provider: 'github' | 'gitlab'
  details: unknown
  contents?: unknown
}): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
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
          provider: options.provider,
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
      return { ok: true, result: options.details }
    }
    if (method === 'github.prFileContents') {
      return { ok: true, result: options.contents }
    }
    return { ok: false, error: { message: `Unexpected ${method}` } }
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
