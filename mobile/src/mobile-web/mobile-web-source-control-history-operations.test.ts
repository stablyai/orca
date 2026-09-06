import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES
} from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'
import { executeMobileWebSourceControlHistoryOperation as executeHistoryOperation } from './mobile-web-source-control-history-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture()
const branchComparePager = new MobileWebSourceControlBranchComparePager()

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)

describe('mobile web source-control history operations', () => {
  it('resolves only the workspace selector and bounds local branches', async () => {
    const branches = [
      'main',
      ...Array.from(
        { length: MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT },
        (_, index) => `feature/${index}`
      ),
      '--malicious'
    ]
    const client = rpcClient({ current: 'main', branches })
    const result = await executeMobileWebSourceControlHistoryOperation({
      operation: 'branches',
      payload: { workspaceId: 'workspace-1' },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.localBranches', {
      worktree: 'id:workspace-1'
    })
    expect(result).toMatchObject({
      workspaceId: 'workspace-1',
      current: 'main',
      totalCount: branches.length,
      truncated: true
    })
    expect('branches' in result && result.branches).toHaveLength(
      MOBILE_WEB_SOURCE_CONTROL_BRANCH_LIMIT
    )
    expect(JSON.stringify(result)).not.toContain('--malicious')
  })

  it('sanitizes bounded history without forwarding email or host-only data', async () => {
    const client = rpcClient({
      items: [
        {
          id: OID_A,
          parentIds: [OID_B],
          subject: 'feat: bounded history',
          message: 'x'.repeat(9 * 1024),
          author: 'Orca Contributor',
          authorEmail: 'private@example.com',
          timestamp: 1_784_000_000_000,
          hostPath: '/private/repository',
          references: [
            {
              id: 'refs/heads/feature/mobile',
              name: 'feature/mobile',
              revision: OID_A,
              category: 'branches'
            }
          ]
        },
        { id: 'not-an-object-id', message: 'drop me' }
      ],
      currentRef: {
        id: 'refs/heads/feature/mobile',
        name: 'feature/mobile',
        revision: OID_A,
        category: 'branches'
      },
      hasIncomingChanges: true,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    })
    const result = await executeMobileWebSourceControlHistoryOperation({
      operation: 'history',
      payload: { workspaceId: 'workspace-1', limit: 50, baseRef: 'main' },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.history', {
      worktree: 'id:workspace-1',
      limit: 50,
      baseRef: 'main'
    })
    if (!('items' in result)) {
      throw new Error('Expected history result')
    }
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.message).toHaveLength(8 * 1024)
    expect(result.hasMore).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('/private/repository')
  })

  it('retains history and compare results within negotiated aggregate byte budgets', async () => {
    const historyClient = rpcClient({
      items: Array.from({ length: 100 }, (_, index) => ({
        id: index.toString(16).padStart(40, '0'),
        parentIds: [],
        subject: `Commit ${index}`,
        message: 'x'.repeat(8 * 1024),
        references: []
      })),
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 100
    })
    const history = await executeMobileWebSourceControlHistoryOperation({
      operation: 'history',
      payload: { workspaceId: 'workspace-1', limit: 100 },
      client: historyClient,
      workspaceAuthority
    })
    expect(encodedBytes(history)).toBeLessThanOrEqual(
      MOBILE_WEB_SOURCE_CONTROL_HISTORY_RESPONSE_MAX_BYTES
    )
    expect('items' in history && history.items.length).toBeLessThan(100)
    expect('hasMore' in history && history.hasMore).toBe(true)

    const longPath = [0, 1, 2].map(() => 'p'.repeat(250)).join('/')
    const compareClient = rpcClient({
      summary: {
        baseOid: OID_A,
        compareRef: 'feature/mobile',
        headOid: OID_B,
        mergeBase: OID_A,
        changedFiles: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
        status: 'ready'
      },
      entries: Array.from(
        { length: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT },
        (_, index) => ({
          path: `${longPath}/file-${index}.ts`,
          oldPath: `${longPath}/old-${index}.ts`,
          status: 'renamed'
        })
      )
    })
    const compare = await executeMobileWebSourceControlHistoryOperation({
      operation: 'branchCompare',
      payload: { workspaceId: 'workspace-1', baseRef: 'main' },
      client: compareClient,
      workspaceAuthority
    })
    expect(encodedBytes(compare)).toBeLessThanOrEqual(
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES
    )
    expect('entries' in compare && compare.entries.length).toBeLessThan(
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT
    )
    expect('nextOffset' in compare && compare.nextOffset).not.toBeNull()
    expect('truncated' in compare && compare.truncated).toBe(true)
  })

  it('bounds branch comparison entries and omits host error details', async () => {
    const entries = Array.from(
      { length: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1 },
      (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'modified',
        added: index,
        hostPath: `/private/repository/src/file-${index}.ts`
      })
    )
    const client = rpcClient({
      summary: {
        baseRef: 'main',
        baseOid: OID_A,
        compareRef: 'feature/mobile',
        headOid: OID_B,
        mergeBase: OID_A,
        changedFiles: entries.length,
        commitsAhead: 3,
        status: 'ready',
        errorMessage: '/private/repository should stay native'
      },
      entries
    })
    const result = await executeMobileWebSourceControlHistoryOperation({
      operation: 'branchCompare',
      payload: { workspaceId: 'workspace-1', baseRef: 'main' },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.branchCompare', {
      worktree: 'id:workspace-1',
      baseRef: 'main'
    })
    if (!('baseOid' in result)) {
      throw new Error('Expected branch comparison')
    }
    expect(result).toMatchObject({
      workspaceId: 'workspace-1',
      baseRef: 'main',
      changedFiles: entries.length,
      commitsAhead: 3,
      totalEntries: entries.length,
      truncated: true
    })
    expect(result.entries).toHaveLength(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT)
    expect(result.nextOffset).toBe(MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT)
    expect(JSON.stringify(result)).not.toContain('/private/repository')
    expect(JSON.stringify(result)).not.toContain('errorMessage')

    expect(
      branchComparePager.claimContinuation({
        workspaceId: 'workspace-1',
        baseRef: 'main',
        offset: result.nextOffset,
        expectedRevision: result.revision
      })
    ).toBe(true)
    const continuation = await executeMobileWebSourceControlHistoryOperation({
      operation: 'branchCompare',
      payload: {
        workspaceId: 'workspace-1',
        baseRef: 'main',
        offset: result.nextOffset,
        expectedRevision: result.revision
      },
      client,
      workspaceAuthority
    })
    if (!('baseOid' in continuation)) {
      throw new Error('Expected branch comparison continuation')
    }
    expect(continuation).toMatchObject({
      revision: result.revision,
      offset: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT,
      entries: [{ relativePath: `src/file-${entries.length - 1}.ts` }],
      nextOffset: null
    })
  })

  it('serves a continuation from one stable host snapshot', async () => {
    const entries = Array.from(
      { length: MOBILE_WEB_SOURCE_CONTROL_COMPARE_ENTRY_LIMIT + 1 },
      (_, index) => ({ path: `src/file-${index}.ts`, status: 'modified' })
    )
    const client = rpcClient({
      summary: {
        baseOid: OID_A,
        compareRef: 'feature/mobile',
        headOid: OID_B,
        mergeBase: OID_A,
        changedFiles: entries.length,
        status: 'ready'
      },
      entries
    })
    const first = await executeMobileWebSourceControlHistoryOperation({
      operation: 'branchCompare',
      payload: { workspaceId: 'workspace-1', baseRef: 'main' },
      client,
      workspaceAuthority
    })
    if (!('baseOid' in first) || first.nextOffset === null) {
      throw new Error('Expected branch comparison page')
    }
    vi.mocked(client.sendRequest).mockResolvedValueOnce({
      ok: true,
      result: {
        summary: {
          baseOid: OID_A,
          compareRef: 'feature/mobile',
          headOid: 'c'.repeat(40),
          mergeBase: OID_A,
          changedFiles: entries.length,
          status: 'ready'
        },
        entries
      }
    })

    const payload = {
      workspaceId: 'workspace-1',
      baseRef: 'main',
      offset: first.nextOffset,
      expectedRevision: first.revision
    }
    expect(branchComparePager.claimContinuation(payload)).toBe(true)
    await expect(
      executeMobileWebSourceControlHistoryOperation({
        operation: 'branchCompare',
        payload,
        client,
        workspaceAuthority
      })
    ).resolves.toMatchObject({ revision: first.revision, nextOffset: null })
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('requires a full commit ID and returns request-bound comparison identity', async () => {
    const client = rpcClient({
      summary: {
        commitOid: OID_A,
        parentOid: OID_B,
        compareRef: OID_A.slice(0, 7),
        baseRef: OID_B.slice(0, 7),
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }]
    })
    await expect(
      executeMobileWebSourceControlHistoryOperation({
        operation: 'commitCompare',
        payload: { workspaceId: 'workspace-1', commitId: 'abc1234' },
        client,
        workspaceAuthority
      })
    ).rejects.toBeDefined()
    expect(client.sendRequest).not.toHaveBeenCalled()

    await expect(
      executeMobileWebSourceControlHistoryOperation({
        operation: 'commitCompare',
        payload: { workspaceId: 'workspace-1', commitId: OID_A },
        client,
        workspaceAuthority
      })
    ).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      commitId: OID_A,
      commitOid: OID_A,
      parentOid: OID_B,
      changedFiles: 1,
      truncated: false
    })
  })
})

function rpcClient(result: unknown): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({ ok: true, result })
  } as unknown as RpcClient
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function executeMobileWebSourceControlHistoryOperation(
  args: Omit<Parameters<typeof executeHistoryOperation>[0], 'branchComparePager'>
) {
  return executeHistoryOperation({ ...args, branchComparePager })
}
