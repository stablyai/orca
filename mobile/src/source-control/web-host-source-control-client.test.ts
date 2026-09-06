import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MobileWebBridgeClientError } from '../../../src/mobile-web/src/mobile-web-bridge-client-error'
import { webHostSourceControlClient } from './web-host-source-control-client'

const WORKSPACE_ID = 'workspace-page-1'
const HEAD = 'a'.repeat(40)

describe('web host source control client', () => {
  it('projects bounded status into the unchanged mobile model', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlStatus.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      branch: 'main',
      head: HEAD,
      conflictOperation: 'unknown',
      entries: [
        {
          relativePath: 'src/app.ts',
          status: 'modified',
          area: 'unstaged',
          added: 2,
          removed: 1
        }
      ],
      totalCount: 1,
      truncated: false
    })
    bridge.sourceControlUpstream.mockResolvedValue(repositoryState())
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('git.status', {
      worktree: `id:${WORKSPACE_ID}`
    })

    expect(response.ok && response.result).toEqual({
      entries: [
        {
          path: 'src/app.ts',
          status: 'modified',
          area: 'unstaged',
          added: 2,
          removed: 1
        }
      ],
      conflictOperation: 'unknown',
      head: HEAD,
      branch: 'main',
      upstreamStatus: repositoryState().upstream,
      didHitLimit: false,
      statusLength: 1
    })
  })

  it('revalidates displayed entries before a mutation', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlStatus.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      branch: 'main',
      head: HEAD,
      conflictOperation: 'unknown',
      entries: [
        {
          relativePath: 'src/app.ts',
          status: 'modified',
          area: 'unstaged'
        }
      ],
      totalCount: 1,
      truncated: false
    })
    bridge.sourceControlStage.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      operation: 'stage',
      relativePaths: ['src/app.ts'],
      mutated: true
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('git.stage', {
      worktree: `id:${WORKSPACE_ID}`,
      filePath: 'src/app.ts'
    })

    expect(response.ok).toBe(true)
    expect(bridge.sourceControlStage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      entries: [
        {
          relativePath: 'src/app.ts',
          status: 'modified',
          area: 'unstaged'
        }
      ]
    })
  })

  it('rejects a guessed workspace selector before bridge dispatch', async () => {
    const bridge = bridgeClient()
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('git.status', {
      worktree: 'id:workspace-page-guessed'
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(bridge.sourceControlStatus).not.toHaveBeenCalled()
  })

  it('opens a Session-origin changed file through the hosted review operation', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlReviewOpen.mockResolvedValue(null)
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('files.openDiff', {
      worktree: `id:${WORKSPACE_ID}`,
      relativePath: 'src/app.ts',
      staged: true
    })

    expect(response.ok).toBe(true)
    expect(bridge.sourceControlReviewOpen).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      relativePath: 'src/app.ts',
      scope: 'staged'
    })
  })

  it('preserves the edit fallback when the host cannot open diffs', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlReviewOpen.mockRejectedValue(
      new MobileWebBridgeClientError('unsupported_capability', false)
    )
    bridge.fileOpen.mockResolvedValue(null)
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const diff = await client.sendRequest('files.openDiff', {
      worktree: `id:${WORKSPACE_ID}`,
      relativePath: 'src/app.ts',
      staged: false
    })
    const file = await client.sendRequest('files.open', {
      worktree: `id:${WORKSPACE_ID}`,
      relativePath: 'src/app.ts'
    })

    expect(diff).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(file.ok).toBe(true)
    expect(bridge.fileOpen).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      relativePath: 'src/app.ts'
    })
  })

  it('reveals the opened diff through the hosted Session bridge', async () => {
    const bridge = bridgeClient()
    const snapshot = {
      workspaceId: WORKSPACE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 7,
      activeTabId: 'diff-1',
      activeTabType: 'file' as const,
      tabs: [
        {
          id: 'diff-1',
          title: 'app.ts',
          type: 'file' as const,
          relativePath: 'src/app.ts',
          mode: 'diff' as const,
          diffSource: 'unstaged' as const,
          isActive: true
        }
      ],
      truncated: false
    }
    bridge.sessionSnapshot.mockResolvedValue(snapshot)
    bridge.sessionActivate.mockResolvedValue(snapshot)
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const listed = await client.sendRequest('session.tabs.list', {
      worktree: `id:${WORKSPACE_ID}`
    })
    const activated = await client.sendRequest('session.tabs.activate', {
      worktree: `id:${WORKSPACE_ID}`,
      tabId: 'diff-1',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })

    expect(listed).toMatchObject({
      ok: true,
      result: {
        worktree: WORKSPACE_ID,
        activeTabId: 'diff-1',
        tabs: [
          {
            id: 'diff-1',
            type: 'file',
            relativePath: 'src/app.ts',
            mode: 'diff',
            diffSource: 'unstaged'
          }
        ]
      }
    })
    expect(bridge.sessionSnapshot).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
    expect(bridge.sessionActivate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      tabId: 'diff-1'
    })
    expect(activated).toMatchObject({ ok: true, result: { activeTabId: 'diff-1' } })
  })

  it('maps push through an exact repository snapshot', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlUpstream.mockResolvedValue(repositoryState())
    bridge.sourceControlPush.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      operation: 'push',
      previousHead: HEAD,
      previousBranch: 'main',
      repository: repositoryState(),
      completed: true
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const response = await client.sendRequest('git.push', {
      worktree: `id:${WORKSPACE_ID}`,
      publish: true
    })

    expect(response.ok).toBe(true)
    expect(bridge.sourceControlPush).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main',
      expectedUpstream: repositoryState().upstream,
      mode: 'publish',
      confirmation: 'push-confirmed'
    })
  })

  it('maps manual review linking without exposing the host workspace identity', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlReviewLink.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      baseRef: 'main',
      linkedGitHubPR: 17,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    bridge.sourceControlReviewLinkUpdate.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      baseRef: 'main',
      linkedGitHubPR: 23,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    bridge.sourceControlUpstream.mockResolvedValue(repositoryState())
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    const read = await client.sendRequest('worktree.show', {
      worktree: `id:${WORKSPACE_ID}`
    })
    const write = await client.sendRequest('worktree.set', {
      worktree: `id:${WORKSPACE_ID}`,
      linkedPR: 23
    })

    expect(read).toMatchObject({ ok: true, result: { worktree: { linkedPR: 17 } } })
    expect(write.ok).toBe(true)
    expect(bridge.sourceControlReviewLinkUpdate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      number: 23
    })
  })

  it('uses shell-derived review eligibility and creation identity', async () => {
    const bridge = bridgeClient()
    bridge.sourceControlStatus.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      branch: 'main',
      head: HEAD,
      conflictOperation: 'unknown',
      entries: [],
      totalCount: 0,
      truncated: false
    })
    bridge.providerReviewCreationEligibility.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      observedHead: HEAD,
      branch: 'main',
      provider: 'github',
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'not_found',
      defaultBaseRef: 'main'
    })
    bridge.providerReviewCreate.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: 'github',
      ok: true,
      number: 17,
      url: 'https://github.example/acme/orca/pull/17'
    })
    bridge.providerReviewGenerateFields.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      success: true,
      fields: {
        base: 'main',
        title: 'Generated',
        body: 'Generated body',
        draft: false
      }
    })
    const client = webHostSourceControlClient(
      bridge as unknown as MobileWebBridgeClient,
      WORKSPACE_ID
    )

    await client.sendRequest('hostedReview.getCreationEligibility', {
      worktree: `id:${WORKSPACE_ID}`,
      branch: 'page-controlled',
      hasUncommittedChanges: false,
      ahead: 999
    })
    const created = await client.sendRequest('hostedReview.create', {
      worktree: `id:${WORKSPACE_ID}`,
      provider: 'github',
      base: 'main',
      title: 'Ship it',
      draft: false
    })
    const generated = await client.sendRequest('git.generatePullRequestFields', {
      worktree: `id:${WORKSPACE_ID}`,
      base: 'main',
      title: 'Draft',
      body: '',
      draft: false
    })

    expect(bridge.providerReviewCreationEligibility).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main'
    })
    expect(bridge.providerReviewCreate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      expectedHead: HEAD,
      expectedBranch: 'main',
      provider: 'github',
      base: 'main',
      title: 'Ship it',
      body: '',
      draft: false
    })
    expect(created).toMatchObject({
      ok: true,
      result: { ok: true, number: 17 }
    })
    expect(generated).toMatchObject({
      ok: true,
      result: { success: true, fields: { title: 'Generated' } }
    })
  })
})

function repositoryState() {
  return {
    workspaceId: WORKSPACE_ID,
    head: HEAD,
    branch: 'main',
    conflictOperation: 'unknown' as const,
    baseRef: 'origin/main',
    upstream: {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 1,
      behind: 0,
      hasConfiguredPushTarget: true,
      behindCommitsArePatchEquivalent: false
    }
  }
}

function bridgeClient() {
  return {
    sourceControlStatus: vi.fn(),
    sourceControlUpstream: vi.fn(),
    sourceControlBranches: vi.fn(),
    sourceControlHistory: vi.fn(),
    sourceControlBranchCompare: vi.fn(),
    sourceControlCommitCompare: vi.fn(),
    sourceControlStage: vi.fn(),
    sourceControlUnstage: vi.fn(),
    sourceControlDiscard: vi.fn(),
    sourceControlCommit: vi.fn(),
    sourceControlGenerateCommitMessage: vi.fn(),
    sourceControlCancelCommitMessageGeneration: vi.fn(),
    sourceControlCheckout: vi.fn(),
    sourceControlFetch: vi.fn(),
    sourceControlPull: vi.fn(),
    sourceControlPush: vi.fn(),
    sourceControlRebase: vi.fn(),
    sourceControlAbort: vi.fn(),
    sourceControlReviewLink: vi.fn(),
    sourceControlReviewLinkUpdate: vi.fn(),
    sourceControlReviewOpen: vi.fn(),
    fileOpen: vi.fn(),
    sessionSnapshot: vi.fn(),
    sessionActivate: vi.fn(),
    providerReviewCreationEligibility: vi.fn(),
    providerReviewCreate: vi.fn(),
    providerReviewGenerateFields: vi.fn()
  }
}
