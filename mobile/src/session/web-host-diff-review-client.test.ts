import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostDiffReviewClient } from './web-host-diff-review-client'

const revision = 'a'.repeat(64)

describe('web host diff review client', () => {
  it('loads every revision-bound diff page without reconstructing source files', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlReviewDiff = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        scope: 'unstaged',
        kind: 'text',
        revision,
        offset: 0,
        totalRows: 3,
        rows: [diffRow(0, 'delete', 'before', 1), diffRow(1, 'add', 'after', undefined, 1)],
        nextOffset: 2,
        truncated: false
      })
      .mockResolvedValueOnce({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        scope: 'unstaged',
        kind: 'text',
        revision,
        offset: 2,
        totalRows: 3,
        rows: [diffRow(2, 'context', 'same', 2, 2)],
        nextOffset: null,
        truncated: false
      })
    const client = webHostDiffReviewClient(
      bridge as unknown as MobileWebBridgeClient,
      'workspace-1'
    )

    const response = await client.sendRequest('git.diff', {
      worktree: 'id:workspace-1',
      filePath: 'src/app.ts',
      staged: false
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        kind: 'rows',
        truncated: false,
        rows: [
          { kind: 'delete', text: 'before', oldLineNumber: 1 },
          { kind: 'add', text: 'after', newLineNumber: 1 },
          { kind: 'context', text: 'same', oldLineNumber: 2, newLineNumber: 2 }
        ]
      }
    })
    expect(bridge.sourceControlReviewDiff).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 2, expectedRevision: revision })
    )
    expect(JSON.stringify(response)).not.toContain('originalContent')
  })

  it('rejects a stale continuation instead of mixing diff revisions', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlReviewDiff = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        scope: 'unstaged',
        kind: 'text',
        revision,
        offset: 0,
        totalRows: 2,
        rows: [diffRow(0, 'delete', 'before', 1)],
        nextOffset: 1,
        truncated: false
      })
      .mockResolvedValueOnce({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        scope: 'unstaged',
        kind: 'text',
        revision: 'b'.repeat(64),
        offset: 1,
        totalRows: 2,
        rows: [diffRow(1, 'add', 'after', undefined, 1)],
        nextOffset: null,
        truncated: false
      })
    const client = webHostDiffReviewClient(
      bridge as unknown as MobileWebBridgeClient,
      'workspace-1'
    )

    await expect(
      client.sendRequest('git.diff', {
        worktree: 'id:workspace-1',
        filePath: 'src/app.ts',
        staged: false
      })
    ).resolves.toMatchObject({ ok: false, error: { message: 'Source control action failed' } })
  })

  it('assembles every revision-bound branch comparison page for the unchanged Review UI', async () => {
    const bridge = bridgeClient()
    const firstEntries = Array.from({ length: 128 }, (_, index) => ({
      relativePath: `src/file-${index}.ts`,
      status: 'modified'
    }))
    bridge.sourceControlBranchCompare = vi
      .fn()
      .mockResolvedValueOnce(branchComparePage(firstEntries, 0, 128))
      .mockResolvedValueOnce(
        branchComparePage([{ relativePath: 'src/file-128.ts', status: 'added' }], 128, null)
      )
    const client = webHostDiffReviewClient(
      bridge as unknown as MobileWebBridgeClient,
      'workspace-1'
    )

    const response = await client.sendRequest('git.branchCompare', {
      worktree: 'id:workspace-1',
      baseRef: 'main'
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        summary: { baseRef: 'main', changedFiles: 129 },
        entries: [
          { path: 'src/file-0.ts', status: 'modified' },
          ...Array.from({ length: 127 }, (_, index) => ({
            path: `src/file-${index + 1}.ts`,
            status: 'modified'
          })),
          { path: 'src/file-128.ts', status: 'added' }
        ]
      }
    })
    expect(bridge.sourceControlBranchCompare).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1',
      baseRef: 'main',
      offset: 128,
      limit: 128,
      expectedRevision: revision
    })
  })

  it('rejects a stale branch comparison page instead of mixing Review queues', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlBranchCompare = vi
      .fn()
      .mockResolvedValueOnce(
        branchComparePage([{ relativePath: 'src/app.ts', status: 'modified' }], 0, 1)
      )
      .mockResolvedValueOnce({
        ...branchComparePage([{ relativePath: 'src/next.ts', status: 'modified' }], 1, null),
        revision: 'b'.repeat(64)
      })
    const client = webHostDiffReviewClient(
      bridge as unknown as MobileWebBridgeClient,
      'workspace-1'
    )

    await expect(
      client.sendRequest('git.branchCompare', {
        worktree: 'id:workspace-1',
        baseRef: 'main'
      })
    ).resolves.toMatchObject({ ok: false, error: { message: 'Source control action failed' } })
  })

  it('maps shell metadata, session tabs, diff opening, and terminal send locally', async () => {
    const bridge = bridgeClient()
    const client = webHostDiffReviewClient(
      bridge as unknown as MobileWebBridgeClient,
      'workspace-1'
    )

    const metadata = await client.sendRequest('worktree.show', {
      worktree: 'id:workspace-1'
    })
    expect(metadata).toMatchObject({
      ok: true,
      result: {
        worktree: {
          id: 'workspace-1',
          baseRef: 'main',
          diffComments: [{ filePath: 'src/app.ts', worktreeId: 'workspace-1' }]
        }
      }
    })

    await expect(
      client.sendRequest('worktree.set', {
        worktree: 'id:workspace-1',
        diffComments: [
          {
            id: 'note-1',
            worktreeId: 'workspace-1',
            filePath: 'src/app.ts',
            lineNumber: 4,
            body: 'Updated',
            createdAt: 1,
            side: 'modified'
          }
        ],
        mobileDiffReview: { version: 1, files: {} }
      })
    ).resolves.toMatchObject({ ok: true })
    expect(bridge.sourceControlReviewMetadataUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1', expectedRevision: revision })
    )

    await expect(
      client.sendRequest('files.openDiff', {
        worktree: 'id:workspace-1',
        relativePath: 'src/app.ts',
        staged: true
      })
    ).resolves.toMatchObject({ ok: true })
    expect(bridge.sourceControlReviewOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      scope: 'staged'
    })

    const tabs = await client.sendRequest('session.tabs.list', {
      worktree: 'id:workspace-1'
    })
    expect(tabs).toMatchObject({
      ok: true,
      result: {
        tabs: [{ id: 'tab-1', type: 'terminal', terminal: 'tab-1' }]
      }
    })
    await expect(
      client.sendRequest('terminal.send', {
        terminal: 'tab-1',
        text: 'Review prompt',
        enter: true
      })
    ).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(bridge.sourceControlReviewTerminalSend).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      text: 'Review prompt',
      enter: true
    })
  })
})

function bridgeClient() {
  return {
    sourceControlUpstream: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      head: 'b'.repeat(40),
      branch: 'feature',
      baseRef: 'main',
      upstream: {
        hasUpstream: true,
        ahead: 1,
        behind: 0,
        hasConfiguredPushTarget: true,
        behindCommitsArePatchEquivalent: false
      }
    }),
    sourceControlReviewMetadata: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      revision,
      comments: [
        {
          id: 'note-1',
          relativePath: 'src/app.ts',
          lineNumber: 4,
          body: 'Review this',
          createdAt: 1,
          side: 'modified'
        }
      ],
      reviewState: { version: 1, files: [] }
    }),
    sourceControlReviewLink: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      baseRef: 'main',
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    }),
    sourceControlReviewMetadataUpdate: vi.fn().mockImplementation((payload) =>
      Promise.resolve({
        workspaceId: payload.workspaceId,
        revision: 'b'.repeat(64),
        comments: payload.comments,
        reviewState: payload.reviewState
      })
    ),
    sourceControlBranchCompare: vi.fn(),
    sourceControlReviewDiff: vi.fn(),
    sourceControlReviewOpen: vi.fn().mockResolvedValue(null),
    sourceControlReviewTerminalSend: vi.fn().mockResolvedValue({ accepted: true }),
    sessionSnapshot: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      activeTabId: 'tab-1',
      activeTabType: 'terminal',
      tabs: [
        {
          id: 'tab-1',
          title: 'Agent',
          type: 'terminal',
          status: 'ready',
          isActive: true
        }
      ],
      truncated: false
    }),
    sessionCreate: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      tabId: 'tab-2',
      created: true
    })
  }
}

function branchComparePage(
  entries: { relativePath: string; status: 'modified' | 'added' }[],
  offset: number,
  nextOffset: number | null
) {
  return {
    workspaceId: 'workspace-1',
    baseRef: 'main',
    compareRef: 'HEAD',
    baseOid: 'a'.repeat(40),
    headOid: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    changedFiles: 129,
    status: 'ready' as const,
    revision,
    offset,
    totalEntries: 129,
    entries,
    nextOffset,
    truncated: false
  }
}

function diffRow(
  index: number,
  kind: 'context' | 'add' | 'delete',
  text: string,
  oldLineNumber?: number,
  newLineNumber?: number
) {
  return {
    index,
    kind,
    text,
    textTruncated: false,
    ...(oldLineNumber === undefined ? {} : { oldLineNumber }),
    ...(newLineNumber === undefined ? {} : { newLineNumber })
  }
}
