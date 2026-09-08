import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext, RpcMethod } from '../core'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS } from './mobile-web-source-control-repository'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS } from './mobile-web-source-control-review-metadata'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS } from './mobile-web-source-control-review-link'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS } from './mobile-web-source-control-review-diff'
import { MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS } from './mobile-web-source-control-review-terminal-send'
import { mobileWebReviewMetadataRevision } from './mobile-web-source-control-review-projection'

const worktree = 'id:private-host-workspace'
const OID = 'a'.repeat(40)
const METHODS = [
  ...MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS,
  ...MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS
]

function stubMethod(name: string, result: unknown) {
  const method = TERMINAL_SEND_METHODS.find((entry) => entry.name === name)!
  return vi.spyOn(method as RpcMethod, 'handler').mockResolvedValue(result)
}

async function run(
  name: string,
  params: Record<string, unknown> = {},
  runtime: Record<string, unknown> = {},
  context: Partial<RpcContext> = {}
) {
  const method = METHODS.find((entry) => entry.name === name)!
  return method.handler(method.params!.parse({ worktree, ...params }), {
    signal: new AbortController().signal,
    runtime,
    ...context
  } as unknown as RpcContext)
}

const comment = {
  id: 'comment-1',
  relativePath: 'src/app.ts',
  lineNumber: 4,
  body: 'needs a test',
  createdAt: 1,
  side: 'modified' as const
}

const workspaceRecord = {
  id: 'private-host-workspace',
  repoId: 'repo-1',
  path: '/private/repo',
  setupScript: 'curl evil',
  linkedPR: null,
  linkedGitLabMR: null
}

afterEach(() => vi.restoreAllMocks())

describe('host repository state', () => {
  it('composes status, upstream and the workspace base ref into one page-shaped read', async () => {
    const getRuntimeGitStatus = vi
      .fn()
      .mockResolvedValue({ entries: [], head: OID, branch: 'main', conflictOperation: 'unknown' })
    await expect(
      run(
        'mobileWeb.sourceControl.repositoryState',
        {},
        {
          getRuntimeGitStatus,
          getRuntimeGitUpstreamStatus: vi.fn().mockResolvedValue({
            hasUpstream: true,
            ahead: 2,
            behind: 0,
            upstreamName: 'origin/x'
          }),
          showManagedWorktree: vi
            .fn()
            .mockResolvedValue({ ...workspaceRecord, baseRef: 'origin/main' })
        }
      )
    ).resolves.toEqual({
      head: OID,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: 'origin/main',
      upstream: {
        hasUpstream: true,
        upstreamName: 'origin/x',
        ahead: 2,
        behind: 0,
        hasConfiguredPushTarget: false,
        behindCommitsArePatchEquivalent: false
      }
    })
    expect(getRuntimeGitStatus).toHaveBeenCalledWith(worktree, { admissionTier: 'status' })
  })

  it('falls back to the project default when the workspace pinned no base ref', async () => {
    const getRepoBaseRefDefault = vi
      .fn()
      .mockResolvedValue({ defaultBaseRef: 'origin/trunk', remoteCount: 1 })
    const result = await run(
      'mobileWeb.sourceControl.repositoryState',
      {},
      {
        getRuntimeGitStatus: vi
          .fn()
          .mockResolvedValue({ entries: [], branch: 'main', conflictOperation: 'rebase' }),
        getRuntimeGitUpstreamStatus: vi
          .fn()
          .mockResolvedValue({ hasUpstream: false, ahead: 0, behind: 0 }),
        showManagedWorktree: vi.fn().mockResolvedValue(workspaceRecord),
        getRepoBaseRefDefault
      }
    )
    expect(result).toMatchObject({
      head: null,
      baseRef: 'origin/trunk',
      conflictOperation: 'rebase'
    })
    expect(getRepoBaseRefDefault).toHaveBeenCalledWith('id:repo-1')
    expect(JSON.stringify(result)).not.toContain('private')
  })
})

describe('host review metadata', () => {
  it('projects only review fields off the workspace record', async () => {
    const result = (await run(
      'mobileWeb.sourceControl.reviewMetadata',
      {},
      {
        showManagedWorktree: vi.fn().mockResolvedValue({
          ...workspaceRecord,
          diffComments: [
            {
              id: 'comment-1',
              worktreeId: 'private-host-workspace',
              filePath: 'src/app.ts',
              lineNumber: 4,
              body: 'needs a test',
              createdAt: 1,
              side: 'modified'
            }
          ],
          mobileDiffReview: { version: 1, files: {} }
        })
      }
    )) as { comments: unknown[]; revision: string }
    expect(result.comments).toEqual([comment])
    expect(JSON.stringify(result)).not.toMatch(/private|setupScript|workspaceId|worktreeId/)
  })

  it('refuses a stale write and sends only review fields to the workspace record', async () => {
    const showManagedWorktree = vi
      .fn()
      .mockResolvedValue({ ...workspaceRecord, diffComments: [], mobileDiffReview: undefined })
    const updateManagedWorktreeMeta = vi.fn().mockResolvedValue(undefined)
    const runtime = { showManagedWorktree, updateManagedWorktreeMeta }
    const reviewState = { version: 1 as const, files: [] }
    const revision = mobileWebReviewMetadataRevision({
      comments: [],
      reviewState: { version: 1, files: [] }
    })
    await expect(
      run(
        'mobileWeb.sourceControl.reviewMetadataUpdate',
        { expectedRevision: 'b'.repeat(64), comments: [], reviewState },
        runtime
      )
    ).rejects.toThrow('conflict')
    expect(updateManagedWorktreeMeta).not.toHaveBeenCalled()

    await run(
      'mobileWeb.sourceControl.reviewMetadataUpdate',
      { expectedRevision: revision, comments: [comment], reviewState },
      runtime
    )
    expect(updateManagedWorktreeMeta).toHaveBeenCalledWith(worktree, {
      diffComments: [
        {
          id: 'comment-1',
          worktreeId: 'private-host-workspace',
          filePath: 'src/app.ts',
          lineNumber: 4,
          body: 'needs a test',
          createdAt: 1,
          side: 'modified'
        }
      ],
      mobileDiffReview: { version: 1, files: {} }
    })
  })

  it('rejects a write that names another workspace', async () => {
    await expect(
      run(
        'mobileWeb.sourceControl.reviewMetadataUpdate',
        {
          expectedRevision: 'b'.repeat(64),
          comments: [],
          reviewState: { version: 1, files: [] },
          workspaceId: 'other-workspace'
        },
        { showManagedWorktree: vi.fn().mockResolvedValue(workspaceRecord) }
      )
    ).rejects.toThrow()
  })
})

describe('host review link', () => {
  it('reads the linked review numbers and writes one provider field', async () => {
    const updateManagedWorktreeMeta = vi.fn().mockResolvedValue(undefined)
    const runtime = {
      showManagedWorktree: vi
        .fn()
        .mockResolvedValue({ ...workspaceRecord, baseRef: 'main', linkedGitLabMR: 7 }),
      updateManagedWorktreeMeta
    }
    await expect(run('mobileWeb.sourceControl.reviewLink', {}, runtime)).resolves.toEqual({
      baseRef: 'main',
      linkedGitHubPR: null,
      linkedGitLabMR: 7,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    await run(
      'mobileWeb.sourceControl.reviewLinkUpdate',
      { provider: 'github', number: 12 },
      runtime
    )
    expect(updateManagedWorktreeMeta).toHaveBeenCalledWith(worktree, { linkedPR: 12 })
  })
})

describe('host review diff', () => {
  it('pages a staged diff and refuses a branch diff without compare identity', async () => {
    const getRuntimeGitDiff = vi
      .fn()
      .mockResolvedValue({ kind: 'text', originalContent: 'old\n', modifiedContent: 'new\n' })
    await expect(
      run(
        'mobileWeb.sourceControl.reviewDiff',
        { relativePath: 'src/app.ts', scope: 'staged' },
        { getRuntimeGitDiff },
        { clientKind: 'mobile', requestId: 'review-diff' }
      )
    ).resolves.toMatchObject({ kind: 'text', scope: 'staged', relativePath: 'src/app.ts' })
    expect(getRuntimeGitDiff).toHaveBeenCalledWith(worktree, 'src/app.ts', true)
    await expect(
      run('mobileWeb.sourceControl.reviewDiff', { relativePath: 'src/app.ts', scope: 'branch' })
    ).rejects.toThrow()
  })
})

describe('host review terminal send', () => {
  const tabs = (worktreeId: string, tabId: string) => ({
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: worktreeId,
      tabs: [{ id: tabId, type: 'terminal', status: 'ready', terminal: 'terminal-1' }]
    })
  })

  it('resolves the terminal from the requested workspace tab list', async () => {
    const send = stubMethod('terminal.send', { send: { accepted: true } })
    await expect(
      run(
        'mobileWeb.sourceControl.reviewTerminalSend',
        { tabId: 'tab-1', text: 'review this' },
        tabs('private-host-workspace', 'tab-1'),
        { clientId: 'device-1' }
      )
    ).resolves.toEqual({ accepted: true })
    expect(send.mock.calls[0]![0]).toMatchObject({
      terminal: 'terminal-1',
      text: 'review this',
      enter: true,
      client: { id: 'device-1', type: 'mobile' }
    })
  })

  it.each([
    ['another workspace', 'other-workspace', 'tab-1'],
    ['a tab id the workspace does not list', 'private-host-workspace', 'tab-2']
  ])('refuses %s', async (_label, worktreeId, tabId) => {
    const send = stubMethod('terminal.send', { send: { accepted: true } })
    await expect(
      run(
        'mobileWeb.sourceControl.reviewTerminalSend',
        { tabId: 'tab-1', text: 'review this' },
        tabs(worktreeId, tabId),
        { clientId: 'device-1' }
      )
    ).rejects.toThrow('selector_not_found')
    expect(send).not.toHaveBeenCalled()
  })
})
