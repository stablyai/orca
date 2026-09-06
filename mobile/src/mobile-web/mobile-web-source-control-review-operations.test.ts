import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_REVIEW_COMMENT_LIMIT } from '../../../src/shared/mobile-web/source-control-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSourceControlReviewOperation } from './mobile-web-source-control-review-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(
  'page-workspace',
  'host-workspace'
)

describe('mobile web source-control review operations', () => {
  it('reads and updates only bounded hosted-review link metadata', async () => {
    const client = {
      sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'worktree.show') {
          return {
            ok: true,
            result: {
              worktree: {
                baseRef: 'main',
                linkedPR: params.worktree === 'id:host-workspace' ? 17 : 99,
                path: '/private/workspace'
              }
            }
          }
        }
        return { ok: true, result: { success: true } }
      })
    } as unknown as RpcClient

    const read = await executeMobileWebSourceControlReviewOperation({
      operation: 'reviewLink',
      payload: { workspaceId: 'page-workspace' },
      client,
      workspaceAuthority
    })
    expect(read).toMatchObject({
      workspaceId: 'page-workspace',
      baseRef: 'main',
      linkedGitHubPR: 17
    })
    expect(JSON.stringify(read)).not.toContain('/private/workspace')

    await executeMobileWebSourceControlReviewOperation({
      operation: 'reviewLinkUpdate',
      payload: {
        workspaceId: 'page-workspace',
        provider: 'gitlab',
        number: 9,
        baseRef: 'release'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:host-workspace',
      linkedGitLabMR: 9,
      baseRef: 'release'
    })
  })

  it('reads and revision-checks bounded shell-owned review metadata', async () => {
    let worktree = {
      diffComments: [
        {
          id: 'note-1',
          worktreeId: 'host-workspace',
          filePath: 'src/app.ts',
          lineNumber: 4,
          body: 'Review this',
          createdAt: 1,
          scope: 'unstaged',
          side: 'modified'
        }
      ],
      mobileDiffReview: {
        version: 1,
        files: {
          'unstaged:src/app.ts': {
            key: 'unstaged:src/app.ts',
            filePath: 'src/app.ts',
            scope: 'unstaged'
          }
        }
      }
    }
    const client = {
      sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'worktree.show') {
          return { ok: true, result: { worktree } }
        }
        if (method === 'worktree.set') {
          worktree = {
            diffComments: params.diffComments as typeof worktree.diffComments,
            mobileDiffReview: params.mobileDiffReview as typeof worktree.mobileDiffReview
          }
          return { ok: true, result: { success: true } }
        }
        return { ok: false }
      })
    } as unknown as RpcClient

    const first = await executeMobileWebSourceControlReviewOperation({
      operation: 'reviewMetadata',
      payload: { workspaceId: 'page-workspace' },
      client,
      workspaceAuthority
    })
    expect(first).toMatchObject({
      workspaceId: 'page-workspace',
      comments: [{ relativePath: 'src/app.ts', body: 'Review this' }]
    })
    expect(JSON.stringify(first)).not.toContain('host-workspace')
    if (!isMetadata(first)) {
      throw new Error('Expected metadata')
    }

    const updated = await executeMobileWebSourceControlReviewOperation({
      operation: 'reviewMetadataUpdate',
      payload: {
        workspaceId: 'page-workspace',
        expectedRevision: first.revision,
        comments: [{ ...first.comments[0], body: 'Updated note' }],
        reviewState: first.reviewState
      },
      client,
      workspaceAuthority
    })
    expect(updated).toMatchObject({ comments: [{ body: 'Updated note' }] })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({ worktree: 'id:host-workspace' })
    )

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewMetadataUpdate',
        payload: {
          workspaceId: 'page-workspace',
          expectedRevision: first.revision,
          comments: first.comments,
          reviewState: first.reviewState
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects oversized host review metadata before projection', async () => {
    const client = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          worktree: {
            diffComments: Array.from(
              { length: MOBILE_WEB_REVIEW_COMMENT_LIMIT + 1 },
              (_, index) => ({
                id: `note-${index}`,
                filePath: 'src/app.ts',
                lineNumber: 1,
                body: 'body',
                createdAt: 1
              })
            ),
            mobileDiffReview: { version: 1, files: {} }
          }
        }
      })
    } as unknown as RpcClient

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewMetadata',
        payload: { workspaceId: 'page-workspace' },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'too_large' })
  })

  it('revalidates branch diff, diff-tab, and terminal authority natively', async () => {
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'git.branchDiff') {
          return {
            ok: true,
            result: {
              kind: 'text',
              originalContent: 'before\n',
              modifiedContent: 'after\n'
            }
          }
        }
        if (method === 'session.tabs.list') {
          return {
            ok: true,
            result: {
              worktree: 'host-workspace',
              tabs: [
                {
                  id: 'tab-1',
                  type: 'terminal',
                  status: 'ready',
                  terminal: 'host-terminal',
                  isActive: true
                },
                ...Array.from({ length: 199 }, (_, index) => ({
                  id: `filler-${index}`,
                  type: 'file',
                  mode: index === 0 ? 'diff' : 'edit',
                  ...(index === 0 ? { diffSource: 'unstaged' } : {}),
                  relativePath: index === 0 ? 'src/app.ts' : `src/filler-${index}.ts`
                })),
                {
                  id: 'diff-tab',
                  type: 'file',
                  mode: 'diff',
                  diffSource: 'staged',
                  relativePath: 'src/app.ts'
                }
              ]
            }
          }
        }
        if (method === 'session.tabs.activate') {
          return { ok: true, result: { activeTabId: 'diff-tab' } }
        }
        if (method === 'terminal.send') {
          return { ok: true, result: { send: { accepted: true } } }
        }
        return { ok: true, result: null }
      })
    } as unknown as RpcClient
    const compare = {
      baseRef: 'main',
      headOid: 'b'.repeat(40),
      mergeBase: 'a'.repeat(40)
    }

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewDiff',
        payload: {
          workspaceId: 'page-workspace',
          relativePath: 'src/app.ts',
          scope: 'branch',
          compare,
          offset: 0,
          limit: 20
        },
        client,
        workspaceAuthority
      })
    ).resolves.toMatchObject({ kind: 'text', scope: 'branch', totalRows: 2 })
    expect(client.sendRequest).toHaveBeenCalledWith('git.branchDiff', {
      worktree: 'id:host-workspace',
      filePath: 'src/app.ts',
      compare
    })

    await executeMobileWebSourceControlReviewOperation({
      operation: 'reviewOpen',
      payload: {
        workspaceId: 'page-workspace',
        relativePath: 'src/app.ts',
        scope: 'staged'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenCalledWith('files.openDiff', {
      worktree: 'id:host-workspace',
      relativePath: 'src/app.ts',
      staged: true
    })
    expect(client.sendRequest).toHaveBeenCalledWith('session.tabs.activate', {
      worktree: 'id:host-workspace',
      tabId: 'diff-tab',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewTerminalSend',
        payload: {
          workspaceId: 'page-workspace',
          tabId: 'tab-1',
          text: 'Review prompt',
          enter: true
        },
        client,
        workspaceAuthority,
        terminalClientId: 'mobile-client'
      })
    ).resolves.toEqual({ accepted: true })
    expect(client.sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'host-terminal',
      text: 'Review prompt',
      enter: true,
      client: { id: 'mobile-client', type: 'mobile' }
    })
  })

  it('preserves a Desktop input-floor rejection without marking notes sent', async () => {
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'session.tabs.list') {
          return {
            ok: true,
            result: {
              worktree: 'host-workspace',
              tabs: [
                {
                  id: 'tab-1',
                  type: 'terminal',
                  status: 'ready',
                  terminal: 'host-terminal'
                }
              ]
            }
          }
        }
        return { ok: true, result: { send: { accepted: false } } }
      })
    } as unknown as RpcClient

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewTerminalSend',
        payload: {
          workspaceId: 'page-workspace',
          tabId: 'tab-1',
          text: 'Review prompt',
          enter: true
        },
        client,
        workspaceAuthority,
        terminalClientId: 'mobile-client'
      })
    ).resolves.toEqual({ accepted: false })
  })

  it('preserves an unavailable diff method for the page edit fallback', async () => {
    const client = {
      sendRequest: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'method_not_found', message: 'Method not found' }
      })
    } as unknown as RpcClient

    await expect(
      executeMobileWebSourceControlReviewOperation({
        operation: 'reviewOpen',
        payload: {
          workspaceId: 'page-workspace',
          relativePath: 'src/app.ts',
          scope: 'unstaged'
        },
        client,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
  })
})

function isMetadata(value: unknown): value is {
  revision: string
  comments: Record<string, unknown>[]
  reviewState: Record<string, unknown>
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'revision' in value &&
    'comments' in value &&
    'reviewState' in value
  )
}
