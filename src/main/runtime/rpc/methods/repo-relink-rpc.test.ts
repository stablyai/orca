import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'
import {
  REPO_RELINK_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const repo = { id: 'repo-1', path: '/new/app', displayName: 'app', badgeColor: '#000', addedAt: 0 }

function runtimeWith(overrides: Record<string, unknown>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo.update and repo.pathStatuses only call the stubs supplied here.
  return { getRuntimeId: () => 'test-runtime', ...overrides } as unknown as OrcaRuntimeService
}

describe('repo.update path relink', () => {
  it('advertises the relink capability so clients can gate on it', () => {
    expect(RUNTIME_CAPABILITIES).toContain(REPO_RELINK_RUNTIME_CAPABILITY)
  })

  it('keeps the settings-only path unchanged when an older client sends no path', async () => {
    const runtime = runtimeWith({
      updateRepo: vi.fn().mockResolvedValue({ ...repo, displayName: 'renamed' }),
      relinkRepo: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest('repo.update', { repo: 'repo-1', updates: { displayName: 'renamed' } })
    )
    expect(runtime.relinkRepo).not.toHaveBeenCalled()
    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', { displayName: 'renamed' })
    expect(response).toMatchObject({ ok: true, result: { repo: { displayName: 'renamed' } } })
    expect(response).not.toMatchObject({ result: { relink: expect.anything() } })
  })

  it('relinks first, then applies other updates by id', async () => {
    const relinkRepo = vi.fn().mockResolvedValue({
      repo,
      evidence: 'remote-identity',
      movedWorktrees: [{ oldWorktreeId: 'repo-1::/old/app', newWorktreeId: 'repo-1::/new/app' }],
      staleLinkedWorktreeCount: 1
    })
    const updateRepo = vi.fn().mockResolvedValue({ ...repo, displayName: 'renamed' })
    const dispatcher = new RpcDispatcher({
      runtime: runtimeWith({ relinkRepo, updateRepo }),
      methods: REPO_METHODS
    })
    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'path:/old/app',
        forcePath: true,
        updates: { path: '/new/app', displayName: 'renamed' }
      })
    )
    expect(relinkRepo).toHaveBeenCalledWith('path:/old/app', '/new/app', { force: true })
    // Persistence drops the `path` key; only the relink above may move the repo.
    expect(updateRepo).toHaveBeenCalledWith(
      'id:repo-1',
      expect.objectContaining({ displayName: 'renamed' })
    )
    expect(response).toMatchObject({
      ok: true,
      result: {
        repo: { path: '/new/app', displayName: 'renamed' },
        relink: { evidence: 'remote-identity', movedWorktreeCount: 1, staleLinkedWorktreeCount: 1 }
      }
    })
  })

  it('surfaces a coded refusal as an RPC error without touching settings', async () => {
    const updateRepo = vi.fn()
    const dispatcher = new RpcDispatcher({
      runtime: runtimeWith({
        relinkRepo: vi
          .fn()
          .mockRejectedValue(new Error('repo_relink_path_not_found: /new/app does not exist.')),
        updateRepo
      }),
      methods: REPO_METHODS
    })
    const response = await dispatcher.dispatch(
      makeRequest('repo.update', { repo: 'repo-1', updates: { path: '/new/app' } })
    )
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('repo_relink_path_not_found')
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('lists path statuses from the host', async () => {
    const statuses = [
      {
        repoId: 'repo-1',
        hostId: 'local',
        path: '/old/app',
        status: { state: 'missing', reason: 'not-found' }
      }
    ]
    const listRepoPathStatuses = vi.fn().mockResolvedValue(statuses)
    const dispatcher = new RpcDispatcher({
      runtime: runtimeWith({ listRepoPathStatuses }),
      methods: REPO_METHODS
    })
    const response = await dispatcher.dispatch(makeRequest('repo.pathStatuses', { force: true }))
    expect(listRepoPathStatuses).toHaveBeenCalledWith({ force: true })
    expect(response).toMatchObject({ ok: true, result: { statuses } })
    await dispatcher.dispatch(makeRequest('repo.pathStatuses'))
    expect(listRepoPathStatuses).toHaveBeenLastCalledWith({ force: false })
  })
})
