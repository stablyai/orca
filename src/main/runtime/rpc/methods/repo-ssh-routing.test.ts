import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('repo RPC SSH routing', () => {
  it('routes add, create, and clone to the selected SSH runtime', async () => {
    const repo = { id: 'repo-remote', path: '/srv/remote/app', kind: 'git' as const }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      addRepo: vi.fn().mockResolvedValue(repo),
      createRepo: vi.fn().mockResolvedValue({ repo }),
      cloneRepo: vi.fn().mockResolvedValue(repo)
    } satisfies Pick<OrcaRuntimeService, 'getRuntimeId' | 'addRepo' | 'createRepo' | 'cloneRepo'>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements only the repository methods exercised below.
    const dispatcher = new RpcDispatcher({
      runtime: runtime as OrcaRuntimeService,
      methods: REPO_METHODS
    })

    await dispatcher.dispatch(
      makeRequest('repo.add', { path: '/srv/remote/app', kind: 'git', sshConnectionId: 'ssh-vm' })
    )
    await dispatcher.dispatch(
      makeRequest('repo.create', {
        parentPath: '/srv/remote',
        name: 'app',
        kind: 'git',
        sshConnectionId: 'ssh-vm'
      })
    )
    await dispatcher.dispatch(
      makeRequest('repo.clone', {
        url: 'https://github.com/example/app.git',
        destination: '/srv/remote',
        sshConnectionId: 'ssh-vm'
      })
    )

    expect(runtime.addRepo).toHaveBeenCalledWith(
      '/srv/remote/app',
      'git',
      undefined,
      undefined,
      'ssh-vm'
    )
    expect(runtime.createRepo).toHaveBeenCalledWith('/srv/remote', 'app', 'git', 'ssh-vm')
    expect(runtime.cloneRepo).toHaveBeenCalledWith(
      'https://github.com/example/app.git',
      '/srv/remote',
      undefined,
      'ssh-vm'
    )
  })
})
