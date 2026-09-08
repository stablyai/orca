import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebSourceControlReadClient } from './mobile-web-source-control-read-request-client'

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return {
    request,
    client: new MobileWebSourceControlReadClient({
      request
    } as unknown as MobileWebOneShotRequestClient)
  }
}
const payload = {
  workspaceId: 'page-workspace',
  relativePath: 'a.txt',
  area: 'unstaged' as const,
  offset: 2,
  limit: 1,
  expectedRevision: 'a'.repeat(64)
}
const page = {
  relativePath: 'a.txt',
  area: 'unstaged',
  kind: 'text',
  offset: 2,
  revision: payload.expectedRevision,
  totalRows: 3,
  rows: [{ index: 2, kind: 'add', text: 'hello', textTruncated: false }],
  nextOffset: null,
  truncated: false
}

describe('host-projected Source Control reads', () => {
  it('passes paging and cancellation through the generic request without host identity', async () => {
    const f = fixture(page)
    const options = { signal: new AbortController().signal }
    await expect(f.client.diff(payload, options)).resolves.toEqual({
      ...page,
      workspaceId: payload.workspaceId
    })
    expect(f.request).toHaveBeenCalledWith(
      'workspace',
      'hostRequest',
      {
        method: 'mobileWeb.sourceControl.diff',
        workspaceId: payload.workspaceId,
        params: {
          relativePath: 'a.txt',
          area: 'unstaged',
          offset: 2,
          limit: 1,
          expectedRevision: payload.expectedRevision
        }
      },
      expect.anything(),
      expect.anything(),
      options
    )
  })
  it.each([
    { relativePath: 'other.txt' },
    { offset: 0 },
    { revision: 'b'.repeat(64) },
    { area: 'staged' }
  ])('rejects mismatched diff pages %j', async (mismatch) => {
    await expect(fixture({ ...page, ...mismatch }).client.diff(payload)).rejects.toMatchObject({
      code: 'invalid_message'
    })
  })
  it('rejects a status response exceeding the requested entry count', async () => {
    const f = fixture({
      entries: [1, 2].map((i) => ({
        relativePath: `${i}.txt`,
        status: 'modified',
        area: 'unstaged'
      })),
      totalCount: 2,
      truncated: false,
      conflictOperation: 'unknown'
    })
    await expect(
      f.client.status({ workspaceId: payload.workspaceId, limit: 1 })
    ).rejects.toMatchObject({ code: 'invalid_message' })
  })
})
