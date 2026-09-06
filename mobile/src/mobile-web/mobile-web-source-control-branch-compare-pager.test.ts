import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
  type MobileWebSourceControlBranchComparePayload
} from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture()
const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)

describe('mobile web source-control branch-compare pager', () => {
  it('creates continuation identities without a Node global Buffer', async () => {
    const originalBuffer = globalThis.Buffer
    vi.stubGlobal('Buffer', undefined)
    try {
      const pager = new MobileWebSourceControlBranchComparePager()
      const client = compareClient(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1)

      await expect(pager.page(firstPayload(), client, workspaceAuthority)).resolves.toMatchObject({
        nextOffset: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT
      })
    } finally {
      vi.stubGlobal('Buffer', originalBuffer)
    }
  })

  it('uses one host snapshot across single-use continuation claims', async () => {
    const pager = new MobileWebSourceControlBranchComparePager()
    const client = compareClient(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1)
    const first = await pager.page(firstPayload(), client, workspaceAuthority)
    const continuation = continuationPayload(first)

    expect(pager.claimContinuation({ ...continuation, expectedRevision: 'c'.repeat(64) })).toBe(
      false
    )
    expect(pager.claimContinuation(continuation)).toBe(true)
    expect(pager.claimContinuation(continuation)).toBe(false)

    await expect(pager.page(continuation, client, workspaceAuthority)).resolves.toMatchObject({
      revision: first.revision,
      offset: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
      nextOffset: null
    })
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('revokes abandoned continuations when its authority is cleared', async () => {
    const pager = new MobileWebSourceControlBranchComparePager()
    const client = compareClient(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1)
    const first = await pager.page(firstPayload(), client, workspaceAuthority)
    const continuation = continuationPayload(first)

    pager.clear()

    expect(pager.claimContinuation(continuation)).toBe(false)
    await expect(pager.page(continuation, client, workspaceAuthority)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('keeps two identical comparison sequences independently claimable', async () => {
    const pager = new MobileWebSourceControlBranchComparePager()
    const client = compareClient(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1)
    const [first, second] = await Promise.all([
      pager.page(firstPayload(), client, workspaceAuthority),
      pager.page(firstPayload(), client, workspaceAuthority)
    ])
    const firstContinuation = continuationPayload(first)
    const secondContinuation = continuationPayload(second)

    expect(pager.claimContinuation(firstContinuation, 'request-a')).toBe(true)
    expect(pager.claimContinuation(secondContinuation, 'request-b')).toBe(true)
    await expect(
      Promise.all([
        pager.page(firstContinuation, client, workspaceAuthority, 'request-a'),
        pager.page(secondContinuation, client, workspaceAuthority, 'request-b')
      ])
    ).resolves.toEqual([
      expect.objectContaining({ nextOffset: null }),
      expect.objectContaining({ nextOffset: null })
    ])
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('does not let one comparison identity revoke another', async () => {
    const pager = new MobileWebSourceControlBranchComparePager()
    const client = compareClient(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1)
    const first = await pager.page(firstPayload('main'), client, workspaceAuthority)
    const second = await pager.page(firstPayload('release'), client, workspaceAuthority)
    const firstContinuation = continuationPayload(first, 'main')
    const secondContinuation = continuationPayload(second, 'release')

    expect(pager.claimContinuation(firstContinuation, 'request-a')).toBe(true)
    expect(pager.claimContinuation(secondContinuation, 'request-b')).toBe(true)
  })
})

function firstPayload(baseRef = 'main'): MobileWebSourceControlBranchComparePayload {
  return { workspaceId: 'workspace-1', baseRef, offset: 0, limit: 128 }
}

function continuationPayload(
  first: {
    nextOffset: number | null
    revision: string
  },
  baseRef = 'main'
): MobileWebSourceControlBranchComparePayload {
  if (first.nextOffset === null) {
    throw new Error('Expected a continuation')
  }
  return {
    workspaceId: 'workspace-1',
    baseRef,
    offset: first.nextOffset,
    limit: 128,
    expectedRevision: first.revision
  }
}

function compareClient(entryCount: number): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        summary: {
          baseOid: OID_A,
          compareRef: 'feature/mobile',
          headOid: OID_B,
          mergeBase: OID_A,
          changedFiles: entryCount,
          status: 'ready'
        },
        entries: Array.from({ length: entryCount }, (_, index) => ({
          path: `src/file-${index}.ts`,
          status: 'modified'
        }))
      }
    })
  } as unknown as RpcClient
}
