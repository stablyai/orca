import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebSourceControlReviewRequestClient } from './mobile-web-source-control-review-request-client'

const workspaceId = 'page-workspace'
const revision = 'b'.repeat(64)
const reviewState = { version: 1 as const, files: [] }

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return {
    request,
    client: new MobileWebSourceControlReviewRequestClient({
      request
    } as unknown as MobileWebOneShotRequestClient)
  }
}

function hostRequest(method: string, params: Record<string, unknown>) {
  return ['workspace', 'hostRequest', { method, workspaceId, params }]
}

describe('page review metadata', () => {
  it('reads the projected metadata and restores the page workspace handle', async () => {
    const f = fixture({ revision, comments: [], reviewState })
    await expect(f.client.metadata({ workspaceId })).resolves.toEqual({
      workspaceId,
      revision,
      comments: [],
      reviewState
    })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.reviewMetadata', {})
    )
  })

  it('sends the expected revision the Desktop compares before it writes', async () => {
    const f = fixture({ revision, comments: [], reviewState })
    await f.client.metadataUpdate({
      workspaceId,
      expectedRevision: revision,
      comments: [],
      reviewState
    })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.reviewMetadataUpdate', {
        expectedRevision: revision,
        comments: [],
        reviewState
      })
    )
  })

  it('rejects metadata the contract cannot bound', async () => {
    const f = fixture({ revision: 'not-a-revision', comments: [], reviewState })
    await expect(f.client.metadata({ workspaceId })).rejects.toThrow()
  })
})

describe('page review link', () => {
  it('writes one provider number and reads the link back', async () => {
    const link = {
      baseRef: 'main',
      linkedGitHubPR: 12,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    }
    const f = fixture(link)
    await expect(
      f.client.linkUpdate({ workspaceId, provider: 'github', number: 12 })
    ).resolves.toEqual({ ...link, workspaceId })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.reviewLinkUpdate', { provider: 'github', number: 12 })
    )
  })
})

describe('page review diff', () => {
  it('requires the answered page to match the requested file and scope', async () => {
    const compare = { baseRef: 'main', headOid: 'c'.repeat(40), mergeBase: 'd'.repeat(40) }
    const f = fixture({
      relativePath: 'src/app.ts',
      scope: 'staged',
      kind: 'text',
      revision,
      offset: 0,
      totalRows: 1,
      rows: [{ index: 0, kind: 'add', text: 'hello', textTruncated: false }],
      nextOffset: null,
      truncated: false
    })
    await expect(
      f.client.diff({
        workspaceId,
        relativePath: 'src/app.ts',
        scope: 'branch',
        compare,
        offset: 0,
        limit: 20
      })
    ).rejects.toMatchObject({ code: 'invalid_message' })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.reviewDiff', {
        relativePath: 'src/app.ts',
        scope: 'branch',
        compare,
        offset: 0,
        limit: 20
      })
    )
  })

  it('refuses a branch diff without compare identity', async () => {
    const f = fixture(null)
    await expect(
      f.client.diff({
        workspaceId,
        relativePath: 'src/app.ts',
        scope: 'branch',
        offset: 0,
        limit: 20
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.request).not.toHaveBeenCalled()
  })
})

describe('page review side effects', () => {
  it('opens a diff on the Desktop and sends review text to a session tab', async () => {
    const open = fixture({ opened: true })
    await expect(
      open.client.open({ workspaceId, relativePath: 'src/app.ts', scope: 'staged' })
    ).resolves.toBeNull()
    expect(open.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('files.openDiff', { relativePath: 'src/app.ts', staged: true })
    )

    const send = fixture({ accepted: true })
    await expect(
      send.client.terminalSend({ workspaceId, tabId: 'tab-1', text: 'review this', enter: true })
    ).resolves.toEqual({ accepted: true })
    expect(send.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.reviewTerminalSend', {
        tabId: 'tab-1',
        text: 'review this'
      })
    )
  })
})
