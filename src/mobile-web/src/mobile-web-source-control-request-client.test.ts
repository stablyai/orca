import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebSourceControlRequestClient } from './mobile-web-source-control-request-client'

const workspaceId = 'page-workspace'
const OID = 'a'.repeat(40)

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return {
    request,
    client: new MobileWebSourceControlRequestClient({
      request
    } as unknown as MobileWebOneShotRequestClient)
  }
}

function hostRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
  return [
    'workspace',
    'hostRequest',
    { method, workspaceId, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  ]
}

describe('page Source Control history reads over the host lane', () => {
  it('asks the Desktop for branches and restores the page workspace handle', async () => {
    const f = fixture({ current: 'main', branches: ['main'], totalCount: 1, truncated: false })
    await expect(f.client.branches({ workspaceId })).resolves.toEqual({
      workspaceId,
      current: 'main',
      branches: ['main'],
      totalCount: 1,
      truncated: false
    })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.branches', {})
    )
  })

  it('carries the history limit and refuses a page longer than it asked for', async () => {
    const item = {
      id: OID,
      parentIds: [],
      displayId: 'aaaaaaa',
      subject: 'feat: history',
      message: 'feat: history',
      references: []
    }
    const result = {
      items: [item, { ...item, id: 'b'.repeat(40) }],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 1
    }
    const f = fixture(result)
    await expect(
      f.client.history({ workspaceId, limit: 1, baseRef: 'main' })
    ).rejects.toMatchObject({ code: 'invalid_message' })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.history', { limit: 1, baseRef: 'main' })
    )
  })

  it('rejects a compare answered for another base ref or commit', async () => {
    const compare = fixture({
      baseRef: 'other',
      compareRef: 'HEAD',
      baseOid: OID,
      headOid: OID,
      mergeBase: OID,
      changedFiles: 0,
      status: 'ready',
      entries: [],
      truncated: false
    })
    await expect(
      compare.client.branchCompare({ workspaceId, baseRef: 'main' })
    ).rejects.toMatchObject({ code: 'invalid_message' })
    expect(compare.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.branchCompare', { baseRef: 'main' })
    )

    const commit = fixture({
      commitId: 'b'.repeat(40),
      commitOid: OID,
      parentOid: null,
      compareRef: 'HEAD',
      baseRef: 'parent',
      changedFiles: 0,
      status: 'ready',
      entries: [],
      truncated: false
    })
    await expect(commit.client.commitCompare({ workspaceId, commitId: OID })).rejects.toMatchObject(
      { code: 'invalid_message' }
    )
  })

  it('refuses a request the payload contract rejects before it reaches the bridge', async () => {
    const f = fixture(null)
    await expect(
      f.client.branchCompare({ workspaceId, baseRef: '--upload-pack=evil' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.request).not.toHaveBeenCalled()
  })
})

describe('page Source Control writes over the host lane', () => {
  it('sends one path as a single write and several as a bulk write', async () => {
    const single = fixture({ ok: true })
    await expect(
      single.client.stage({ workspaceId, relativePaths: ['a.ts'] })
    ).resolves.toBeUndefined()
    expect(single.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('git.stage', { filePath: 'a.ts' }, 60_000)
    )

    const bulk = fixture({ ok: true })
    await bulk.client.discard({ workspaceId, relativePaths: ['a.ts', 'b.ts'] })
    expect(bulk.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('git.bulkDiscard', { filePaths: ['a.ts', 'b.ts'] }, 60_000)
    )

    const unstage = fixture({ ok: true })
    await unstage.client.unstage({ workspaceId, relativePaths: ['a.ts', 'b.ts'] })
    expect(unstage.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('git.bulkUnstage', { filePaths: ['a.ts', 'b.ts'] }, 60_000)
    )
  })

  it('refuses a duplicate path set without reaching the bridge', async () => {
    const f = fixture({ ok: true })
    await expect(
      f.client.stage({ workspaceId, relativePaths: ['a.ts', 'a.ts'] })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.request).not.toHaveBeenCalled()
  })

  it('reads a refused commit from the Desktop result', async () => {
    const f = fixture({ success: false, error: 'pre-commit hook failed', hostPath: '/private' })
    await expect(f.client.commit({ workspaceId, message: '  feat: mobile  ' })).resolves.toEqual({
      success: false,
      error: 'pre-commit hook failed'
    })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('git.commit', { message: 'feat: mobile' }, 60_000)
    )
    expect(f.request.mock.calls[0]!.at(-1)).toMatchObject({ timeoutMs: 60_000 })
  })

  it('refuses a blank commit message before it reaches the bridge', async () => {
    const f = fixture({ success: true })
    await expect(f.client.commit({ workspaceId, message: '   ' })).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(f.request).not.toHaveBeenCalled()
  })
})
