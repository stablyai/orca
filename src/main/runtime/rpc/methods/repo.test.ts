import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('repo RPC methods', () => {
  it('creates a repo on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createRepo: vi.fn().mockResolvedValue({
        repo: { id: 'repo-1', path: '/srv/projects/new-app', kind: 'git' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.create', {
        parentPath: '/srv/projects',
        name: 'new-app',
        kind: 'git'
      })
    )

    expect(runtime.createRepo).toHaveBeenCalledWith('/srv/projects', 'new-app', 'git')
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', path: '/srv/projects/new-app' } }
    })
  })

  it('clones a repo on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cloneRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/projects/orca',
        kind: 'git'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.clone', {
        url: 'https://github.com/example/orca.git',
        destination: '/srv/projects'
      })
    )

    expect(runtime.cloneRepo).toHaveBeenCalledWith(
      'https://github.com/example/orca.git',
      '/srv/projects'
    )
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', path: '/srv/projects/orca' } }
    })
  })

  it('routes repository hook operations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      checkRepoHooks: vi.fn().mockResolvedValue({
        hasHooks: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        mayNeedUpdate: false
      }),
      readRepoIssueCommand: vi.fn().mockResolvedValue({
        localContent: null,
        sharedContent: 'Fix {{artifact_url}}',
        effectiveContent: 'Fix {{artifact_url}}',
        localFilePath: '/srv/repo/.orca/issue-command',
        source: 'shared'
      }),
      writeRepoIssueCommand: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    await dispatcher.dispatch(makeRequest('repo.hooksCheck', { repo: 'repo-1' }))
    await dispatcher.dispatch(makeRequest('repo.issueCommandRead', { repo: 'repo-1' }))
    await dispatcher.dispatch(
      makeRequest('repo.issueCommandWrite', {
        repo: 'repo-1',
        content: 'Fix it'
      })
    )

    expect(runtime.checkRepoHooks).toHaveBeenCalledWith('repo-1')
    expect(runtime.readRepoIssueCommand).toHaveBeenCalledWith('repo-1')
    expect(runtime.writeRepoIssueCommand).toHaveBeenCalledWith('repo-1', 'Fix it')
  })
})
