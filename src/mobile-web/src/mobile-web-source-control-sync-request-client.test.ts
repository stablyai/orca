import { describe, expect, it, vi } from 'vitest'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebSourceControlSyncRequestClient } from './mobile-web-source-control-sync-request-client'

const workspaceId = 'page-workspace'
const OID = 'a'.repeat(40)
const upstream = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 1,
  behind: 0,
  hasConfiguredPushTarget: false,
  behindCommitsArePatchEquivalent: false
}

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return {
    request,
    client: new MobileWebSourceControlSyncRequestClient({
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

describe('page repository state', () => {
  it('reads head, branch, base ref and upstream in one Desktop call', async () => {
    const f = fixture({
      head: OID,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: 'origin/main',
      upstream
    })
    await expect(f.client.repositoryState({ workspaceId })).resolves.toEqual({
      workspaceId,
      head: OID,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: 'origin/main',
      upstream
    })
    expect(f.request.mock.calls[0]!.slice(0, 3)).toEqual(
      hostRequest('mobileWeb.sourceControl.repositoryState', {})
    )
  })

  it('refuses a repository state that leaks a host path as the upstream name', async () => {
    const f = fixture({
      head: OID,
      branch: 'main',
      conflictOperation: 'unknown',
      baseRef: null,
      upstream: { ...upstream, upstreamName: '/private/repository' }
    })
    await expect(f.client.repositoryState({ workspaceId })).rejects.toThrow()
  })
})

describe('page repository writes', () => {
  it('maps each write to the Desktop method that performs it', async () => {
    const cases: [() => Promise<void>, string, Record<string, unknown>][] = []
    const f = fixture({ ok: true })
    cases.push(
      [
        () => f.client.checkout({ workspaceId, branch: 'main' }),
        'git.checkout',
        { branch: 'main' }
      ],
      [() => f.client.fetch({ workspaceId }), 'git.fetch', {}],
      [() => f.client.pull({ workspaceId, strategy: 'merge' }), 'git.pull', {}],
      [() => f.client.pull({ workspaceId, strategy: 'fast-forward' }), 'git.fastForward', {}],
      [() => f.client.push({ workspaceId, mode: 'push' }), 'git.push', { publish: false }],
      [() => f.client.push({ workspaceId, mode: 'publish' }), 'git.push', { publish: true }],
      [
        () => f.client.rebase({ workspaceId, baseRef: 'origin/main' }),
        'git.rebaseFromBase',
        { baseRef: 'origin/main' }
      ],
      [() => f.client.abort({ workspaceId, conflictOperation: 'merge' }), 'git.abortMerge', {}],
      [() => f.client.abort({ workspaceId, conflictOperation: 'rebase' }), 'git.abortRebase', {}]
    )
    for (const [index, [run, method, params]] of cases.entries()) {
      await expect(run()).resolves.toBeUndefined()
      expect(f.request.mock.calls[index]!.slice(0, 3), method).toEqual(
        hostRequest(method, params, 60_000)
      )
      // A Git write waits past the read timeout the page applies to itself.
      expect(f.request.mock.calls[index]!.at(-1), method).toMatchObject({ timeoutMs: 60_000 })
    }
  })

  it('refuses a branch name Git could read as an option', async () => {
    const f = fixture({ ok: true })
    await expect(f.client.checkout({ workspaceId, branch: '--force' })).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(f.request).not.toHaveBeenCalled()
  })

  it('surfaces a refused write as the Desktop error', async () => {
    const request = vi.fn().mockRejectedValue(new Error('host_error'))
    const client = new MobileWebSourceControlSyncRequestClient({
      request
    } as unknown as MobileWebOneShotRequestClient)
    await expect(client.push({ workspaceId, mode: 'push' })).rejects.toThrow('host_error')
  })
})
