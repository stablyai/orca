import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createWorkspaceFromComposerSource } from './source-workspace-create'
import type { MobileComposerCreateSelection } from './mobile-composer-source-types'

type Call = { method: string; params: Record<string, unknown> }

function fakeClient(handle: (method: string, call: number) => unknown, calls: Call[]): RpcClient {
  return {
    sendRequest: async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const result = handle(method, calls.length)
      if (result instanceof Error) {
        return {
          id: '1',
          ok: false,
          error: { code: 'x', message: result.message },
          _meta: { runtimeId: 'r' }
        }
      }
      return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
    }
  } as unknown as RpcClient
}

const agent = { choice: 'blank' as const, startupCommand: undefined }

const baseArgs = {
  targetRepoId: 'repo-1',
  setupDecision: 'inherit' as const,
  agent,
  workspaceName: undefined,
  note: undefined,
  supportsIdempotentCutoverRetry: true
}

describe('createWorkspaceFromComposerSource', () => {
  it('creates a GitHub issue workspace linking the issue to its own repo', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-1' } }), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'work-item',
      item: {
        provider: 'github',
        type: 'issue',
        number: 7,
        title: 'Bug',
        url: 'u',
        repoId: 'repo-9'
      }
    }
    // The composer supplies the title-derived name as workspaceName; with none,
    // buildTaskWorkspaceCreateParams falls back to the "<type>-<number>" slug.
    const result = await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(result).toEqual({ worktreeId: 'wt-1', name: 'issue-7' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('worktree.create')
    expect(calls[0]!.params).toMatchObject({
      repo: 'id:repo-9',
      linkedIssue: 7,
      displayName: 'Bug'
    })
  })

  it('passes composer-resolved PR base fields straight through (no re-resolve)', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-2' } }), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'work-item',
      item: {
        provider: 'github',
        type: 'pr',
        number: 3,
        title: 'Feat',
        url: 'u',
        repoId: 'repo-1'
      },
      baseBranch: 'main',
      compareBaseRef: 'origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feat-3' },
      branchNameOverride: 'feat-3'
    }
    await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(calls.map((c) => c.method)).toEqual(['worktree.create'])
    expect(calls[0]!.params).toMatchObject({
      linkedPR: 3,
      baseBranch: 'main',
      compareBaseRef: 'origin/main',
      branchNameOverride: 'feat-3',
      pushTarget: { remoteName: 'origin', branchName: 'feat-3' }
    })
  })

  it('resolves a PR base as a fallback when the selection carries none', async () => {
    const calls: Call[] = []
    const client = fakeClient(
      (method) =>
        method === 'worktree.resolvePrBase'
          ? { baseBranch: 'develop' }
          : { worktree: { id: 'wt-3' } },
      calls
    )
    const selection: MobileComposerCreateSelection = {
      kind: 'work-item',
      item: { provider: 'github', type: 'pr', number: 4, title: 'X', url: 'u', repoId: 'repo-1' }
    }
    await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(calls.map((c) => c.method)).toEqual(['worktree.resolvePrBase', 'worktree.create'])
    expect(calls[1]!.params).toMatchObject({ baseBranch: 'develop', linkedPR: 4 })
  })

  it('creates a Linear workspace with workspace + org routing', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-4' } }), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'work-item',
      item: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: 'Ship it',
        url: 'https://linear.app/acme/issue/ENG-9',
        linearIdentifier: 'ENG-9',
        linearWorkspaceId: 'ws-1',
        linearOrganizationUrlKey: 'acme'
      }
    }
    await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(calls[0]!.params).toMatchObject({
      repo: 'id:repo-1',
      linkedLinearIssue: 'ENG-9',
      linkedLinearIssueWorkspaceId: 'ws-1',
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })
  })

  it('reuses an existing branch with a single attempt (no suffix retry)', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => new Error('Branch "feature" already exists.'), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'branch',
      baseBranch: 'feature',
      refName: 'feature',
      localBranchName: 'feature',
      reuse: true,
      branchNameOverride: 'feature'
    }
    const result = await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect('error' in result).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toMatchObject({
      baseBranch: 'feature',
      branchNameOverride: 'feature'
    })
  })

  it('creates a brand-new branch by name, keeping a slashy name as the branch', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-nb' } }), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'new-branch',
      branchName: 'feature/login'
    }
    const result = await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(result).toEqual({ worktreeId: 'wt-nb', name: 'feature/login' })
    expect(calls[0]!.params).toMatchObject({
      repo: 'id:repo-1',
      name: 'feature/login',
      branchNameOverride: 'feature/login'
    })
  })

  it('suppresses displayName when the name is user-edited (not auto-managed)', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-dn' } }), calls)
    const selection: MobileComposerCreateSelection = {
      kind: 'work-item',
      item: {
        provider: 'github',
        type: 'issue',
        number: 7,
        title: 'Bug',
        url: 'u',
        repoId: 'repo-1'
      }
    }
    await createWorkspaceFromComposerSource({
      client,
      selection,
      ...baseArgs,
      workspaceName: 'my-name',
      nameIsAutoManaged: false
    })
    expect(calls[0]!.params.displayName).toBeUndefined()
    expect(calls[0]!.params).toMatchObject({ name: 'my-name', linkedIssue: 7 })
  })

  it('creates a new branch off a ref, bumping the branch on collision', async () => {
    const calls: Call[] = []
    const client = fakeClient(
      (_m, n) => (n === 1 ? new Error('already exists locally') : { worktree: { id: 'wt-5' } }),
      calls
    )
    const selection: MobileComposerCreateSelection = {
      kind: 'branch',
      baseBranch: 'main',
      refName: 'main',
      localBranchName: 'topic',
      reuse: false,
      branchNameOverride: 'topic'
    }
    const result = await createWorkspaceFromComposerSource({ client, selection, ...baseArgs })
    expect(result).toEqual({ worktreeId: 'wt-5', name: 'topic-2' })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params).toMatchObject({
      baseBranch: 'main',
      branchNameOverride: 'topic-2',
      name: 'topic-2'
    })
  })
})
