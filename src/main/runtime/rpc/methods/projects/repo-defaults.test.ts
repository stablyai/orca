// The mobile Add project flow omits destination/parentPath, so the host fills them
// from its default locations; these cover the dispatcher's fallback to undefined.
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { REPO_METHODS } from './repo'
import { makeRequest } from './repo-rpc.test-fixture'

describe('repo RPC default locations', () => {
  it('clones with a host-side default destination when the caller omits it', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial service fake; the dispatcher only reaches getRuntimeId and cloneRepo here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cloneRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/home/li/orca/orca',
        kind: 'git'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.clone', { url: 'https://github.com/example/orca.git' })
    )

    expect(runtime.cloneRepo).toHaveBeenCalledWith(
      'https://github.com/example/orca.git',
      undefined,
      undefined,
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { repo: { id: 'repo-1' } } })
  })

  it('creates a repo with a host-side default parent when the caller omits it', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial service fake; the dispatcher only reaches getRuntimeId and createRepo here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createRepo: vi.fn().mockResolvedValue({
        repo: { id: 'repo-1', path: '/srv/projects/new-app', kind: 'git' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.create', { name: 'new-app', kind: 'git' })
    )

    expect(runtime.createRepo).toHaveBeenCalledWith(undefined, 'new-app', 'git')
    expect(response).toMatchObject({ ok: true, result: { repo: { id: 'repo-1' } } })
  })
})
