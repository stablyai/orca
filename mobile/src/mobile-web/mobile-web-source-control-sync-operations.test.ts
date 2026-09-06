import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSourceControlSyncOperation } from './mobile-web-source-control-sync-operations'
import { createMobileWebWorkspaceAuthorityFixture } from './mobile-web-workspace-authority-test-fixture'

const workspaceAuthority = createMobileWebWorkspaceAuthorityFixture(
  'repo-1::workspace-1',
  'repo-1::workspace-1'
)

const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)
const upstream = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 2,
  behind: 1,
  hasConfiguredPushTarget: false,
  behindCommitsArePatchEquivalent: false
}

describe('mobile web source-control sync operations', () => {
  it('sanitizes upstream state without forwarding host-only values', async () => {
    const client = rpcClient({
      status: {
        head: HEAD,
        branch: 'main',
        conflictOperation: 'unknown',
        hostPath: '/private/repository'
      },
      upstream: { ...upstream, token: 'secret', remoteUrl: 'ssh://private/repository' }
    })
    const result = await executeMobileWebSourceControlSyncOperation({
      operation: 'upstream',
      payload: { workspaceId: 'repo-1::workspace-1' },
      client,
      workspaceAuthority
    })

    expect(result).toMatchObject({
      workspaceId: 'repo-1::workspace-1',
      head: HEAD,
      branch: 'main',
      baseRef: 'origin/main',
      upstream
    })
    expect(JSON.stringify(result)).not.toContain('/private/repository')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('checks out only a freshly listed local branch', async () => {
    const client = rpcClient({ branches: ['main', 'feature/mobile'] })
    const result = await executeMobileWebSourceControlSyncOperation({
      operation: 'branch',
      payload: {
        ...identity(),
        branch: 'feature/mobile',
        confirmation: 'checkout-confirmed'
      },
      client,
      workspaceAuthority
    })

    expect(client.sendRequest).toHaveBeenCalledWith('git.localBranches', {
      worktree: 'id:repo-1::workspace-1'
    })
    expect(client.sendRequest).toHaveBeenCalledWith('git.checkout', {
      worktree: 'id:repo-1::workspace-1',
      branch: 'feature/mobile'
    })
    expect(result).toMatchObject({
      operation: 'branch',
      previousHead: HEAD,
      previousBranch: 'main',
      branch: 'feature/mobile',
      completed: true
    })
  })

  it('rejects stale or unlisted checkout targets before the write', async () => {
    const stale = rpcClient()
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'branch',
        payload: {
          ...identity(),
          expectedHead: NEXT_HEAD,
          branch: 'feature/mobile',
          confirmation: 'checkout-confirmed'
        },
        client: stale,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(stale, 'git.checkout')).toHaveLength(0)

    const unlisted = rpcClient({ branches: ['main'] })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'branch',
        payload: {
          ...identity(),
          branch: 'feature/mobile',
          confirmation: 'checkout-confirmed'
        },
        client: unlisted,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(unlisted, 'git.checkout')).toHaveLength(0)
  })

  it('uses status-only preflight for checkout and fetch', async () => {
    const checkoutClient = rpcClient({
      branches: ['main', 'feature/mobile'],
      upstreamError: true
    })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'branch',
        payload: {
          ...identity(),
          branch: 'feature/mobile',
          confirmation: 'checkout-confirmed'
        },
        client: checkoutClient,
        workspaceAuthority
      })
    ).resolves.toMatchObject({ operation: 'branch', repository: null })
    expect(callsFor(checkoutClient, 'git.checkout')).toHaveLength(1)

    const fetchClient = rpcClient({ upstreamError: true })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'fetch',
        payload: identity(),
        client: fetchClient,
        workspaceAuthority
      })
    ).resolves.toMatchObject({ operation: 'fetch', repository: null })
    expect(callsFor(fetchClient, 'git.fetch')).toHaveLength(1)
  })

  it('routes fetch and fast-forward pull through existing Desktop RPCs', async () => {
    const fetchClient = rpcClient()
    await executeMobileWebSourceControlSyncOperation({
      operation: 'fetch',
      payload: identity(),
      client: fetchClient,
      workspaceAuthority
    })
    expect(fetchClient.sendRequest).toHaveBeenCalledWith('git.fetch', {
      worktree: 'id:repo-1::workspace-1'
    })

    const pullClient = rpcClient({ upstream: { ...upstream, ahead: 0, behind: 2 } })
    await executeMobileWebSourceControlSyncOperation({
      operation: 'pull',
      payload: {
        ...identity(),
        expectedUpstream: { ...upstream, ahead: 0, behind: 2 },
        strategy: 'fast-forward',
        confirmation: 'pull-confirmed'
      },
      client: pullClient,
      workspaceAuthority
    })
    expect(pullClient.sendRequest).toHaveBeenCalledWith('git.fastForward', {
      worktree: 'id:repo-1::workspace-1'
    })
    expect(callsFor(pullClient, 'git.pull')).toHaveLength(0)
  })

  it('uses merge pull only for a freshly observed divergence', async () => {
    const client = rpcClient()
    await executeMobileWebSourceControlSyncOperation({
      operation: 'pull',
      payload: {
        ...identity(),
        expectedUpstream: upstream,
        strategy: 'merge',
        confirmation: 'pull-confirmed'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenCalledWith('git.pull', {
      worktree: 'id:repo-1::workspace-1'
    })

    const changed = rpcClient({ upstream: { ...upstream, behind: 2 } })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'pull',
        payload: {
          ...identity(),
          expectedUpstream: upstream,
          strategy: 'merge',
          confirmation: 'pull-confirmed'
        },
        client: changed,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(changed, 'git.pull')).toHaveLength(0)
  })

  it('rejects a pull strategy that does not match the observed graph', async () => {
    const behindOnly = { ...upstream, ahead: 0, behind: 2 }
    const mergeClient = rpcClient({ upstream: behindOnly })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'pull',
        payload: {
          ...identity(),
          expectedUpstream: behindOnly,
          strategy: 'merge',
          confirmation: 'pull-confirmed'
        },
        client: mergeClient,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(mergeClient, 'git.pull')).toHaveLength(0)

    const divergedClient = rpcClient()
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'pull',
        payload: {
          ...identity(),
          expectedUpstream: upstream,
          strategy: 'fast-forward',
          confirmation: 'pull-confirmed'
        },
        client: divergedClient,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(divergedClient, 'git.fastForward')).toHaveLength(0)
  })

  it('pushes or publishes without exposing force-with-lease', async () => {
    const pushClient = rpcClient()
    await executeMobileWebSourceControlSyncOperation({
      operation: 'push',
      payload: {
        ...identity(),
        expectedUpstream: upstream,
        mode: 'push',
        confirmation: 'push-confirmed'
      },
      client: pushClient,
      workspaceAuthority
    })
    expect(callsFor(pushClient, 'git.push')[0]?.[1]).toEqual({
      worktree: 'id:repo-1::workspace-1',
      publish: false
    })

    const unpublished = {
      ...upstream,
      hasUpstream: false,
      upstreamName: undefined,
      ahead: 0,
      behind: 0
    }
    const publishClient = rpcClient({ upstream: unpublished })
    await executeMobileWebSourceControlSyncOperation({
      operation: 'push',
      payload: {
        ...identity(),
        expectedUpstream: unpublished,
        mode: 'publish',
        confirmation: 'push-confirmed'
      },
      client: publishClient,
      workspaceAuthority
    })
    const publishParams = callsFor(publishClient, 'git.push')[0]?.[1] as Record<string, unknown>
    expect(publishParams).toEqual({
      worktree: 'id:repo-1::workspace-1',
      publish: true
    })
    expect(publishParams).not.toHaveProperty('forceWithLease')
  })

  it('uses a configured push target without requiring a tracked upstream', async () => {
    const configuredTarget = {
      ...upstream,
      hasUpstream: false,
      upstreamName: undefined,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    }
    const client = rpcClient({ upstream: configuredTarget })
    await executeMobileWebSourceControlSyncOperation({
      operation: 'push',
      payload: {
        ...identity(),
        expectedUpstream: configuredTarget,
        mode: 'push',
        confirmation: 'push-confirmed'
      },
      client,
      workspaceAuthority
    })

    expect(callsFor(client, 'git.push')[0]?.[1]).toEqual({
      worktree: 'id:repo-1::workspace-1',
      publish: false
    })
  })

  it('rebases only onto Orca’s freshly resolved configured base', async () => {
    const client = rpcClient()
    await executeMobileWebSourceControlSyncOperation({
      operation: 'rebase',
      payload: {
        ...identity(),
        expectedUpstream: upstream,
        baseRef: 'origin/main',
        confirmation: 'rebase-confirmed'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenCalledWith('git.rebaseFromBase', {
      worktree: 'id:repo-1::workspace-1',
      baseRef: 'origin/main'
    })

    const wrongBase = rpcClient()
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'rebase',
        payload: {
          ...identity(),
          expectedUpstream: upstream,
          baseRef: 'origin/release',
          confirmation: 'rebase-confirmed'
        },
        client: wrongBase,
        workspaceAuthority
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(callsFor(wrongBase, 'git.rebaseFromBase')).toHaveLength(0)
  })

  it('aborts only the freshly observed merge or rebase operation', async () => {
    const client = rpcClient({
      status: { head: HEAD, branch: 'main', conflictOperation: 'rebase' }
    })
    await executeMobileWebSourceControlSyncOperation({
      operation: 'abort',
      payload: {
        ...identity(),
        conflictOperation: 'rebase',
        confirmation: 'abort-confirmed'
      },
      client,
      workspaceAuthority
    })
    expect(client.sendRequest).toHaveBeenCalledWith('git.abortRebase', {
      worktree: 'id:repo-1::workspace-1'
    })
    expect(callsFor(client, 'git.abortMerge')).toHaveLength(0)
  })

  it('does not make abort authority depend on upstream state', async () => {
    const client = rpcClient({
      status: { head: HEAD, branch: 'main', conflictOperation: 'merge' },
      upstreamError: true
    })
    await expect(
      executeMobileWebSourceControlSyncOperation({
        operation: 'abort',
        payload: {
          ...identity(),
          conflictOperation: 'merge',
          confirmation: 'abort-confirmed'
        },
        client,
        workspaceAuthority
      })
    ).resolves.toMatchObject({ operation: 'abort', repository: null })
    expect(callsFor(client, 'git.abortMerge')).toHaveLength(1)
  })
})

function identity() {
  return {
    workspaceId: 'repo-1::workspace-1',
    expectedHead: HEAD,
    expectedBranch: 'main'
  }
}

function rpcClient(options?: {
  status?: Record<string, unknown>
  upstream?: Record<string, unknown>
  branches?: string[]
  upstreamError?: boolean
}): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const status = options?.status ?? {
    head: HEAD,
    branch: 'main',
    conflictOperation: 'unknown'
  }
  const sendRequest = vi.fn().mockImplementation((method: string) => {
    if (method === 'git.status') {
      return Promise.resolve({ ok: true, result: status })
    }
    if (method === 'git.upstreamStatus') {
      if (options?.upstreamError) {
        return Promise.resolve({ ok: false, error: { code: 'unavailable' } })
      }
      return Promise.resolve({ ok: true, result: options?.upstream ?? upstream })
    }
    if (method === 'worktree.show') {
      return Promise.resolve({ ok: true, result: { worktree: { baseRef: 'origin/main' } } })
    }
    if (method === 'git.localBranches') {
      return Promise.resolve({
        ok: true,
        result: { current: 'main', branches: options?.branches ?? ['main', 'feature/mobile'] }
      })
    }
    return Promise.resolve({ ok: true, result: { ok: true } })
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function callsFor(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
  return client.sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
