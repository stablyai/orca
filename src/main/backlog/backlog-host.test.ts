import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { routeBacklogOperation } from './backlog-host'
import { executeBacklogOperation } from './backlog-service'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'

const mocks = vi.hoisted(() => ({ mux: vi.fn(), request: vi.fn() }))
vi.mock('./backlog-service', () => ({ executeBacklogOperation: vi.fn() }))
vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: mocks.mux }))
const operation = { kind: 'read', id: 'OPS-001' } as const
const repo: Repo = {
  id: 'project',
  path: '/project',
  displayName: 'Project',
  badgeColor: '',
  addedAt: 0,
  kind: 'folder'
}
beforeEach(() => vi.resetAllMocks())

describe('Backlog execution host boundary', () => {
  it('reads local folder projects through the same service', async () => {
    await routeBacklogOperation(repo, operation)
    expect(executeBacklogOperation).toHaveBeenCalledWith('/project', operation)
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
  })
  it('does not substitute local execution when SSH is disconnected', async () => {
    await expect(
      routeBacklogOperation({ ...repo, connectionId: 'remote' }, operation)
    ).rejects.toThrow('Reconnect')
    expect(getActiveMultiplexer).toHaveBeenCalledWith('remote')
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
  it('negotiates the relay before sending an edit and never retries a failed mutation', async () => {
    mocks.mux.mockReturnValue({ request: mocks.request })
    mocks.request.mockResolvedValueOnce({ version: 1 }).mockResolvedValueOnce({ saved: true })
    const edit = {
      kind: 'edit',
      id: 'OPS-001',
      title: 'Task',
      description: '',
      status: 'Review'
    } as const
    await expect(routeBacklogOperation({ ...repo, connectionId: 'remote' }, edit)).resolves.toEqual(
      { saved: true }
    )
    expect(mocks.request.mock.calls).toEqual([
      ['backlog.capabilities', {}, { timeoutMs: 5000 }],
      ['backlog.execute', { repoPath: '/project', operation: edit }, { timeoutMs: 55000 }]
    ])
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
  it.each(['Request timed out', 'SSH disconnected'])(
    'never retries an unconfirmed create: %s',
    async (message) => {
      mocks.mux.mockReturnValue({ request: mocks.request })
      mocks.request.mockResolvedValueOnce({ version: 1 }).mockRejectedValueOnce(new Error(message))
      await expect(
        routeBacklogOperation(
          { ...repo, connectionId: 'remote' },
          { kind: 'create', title: 'Task', description: '', status: 'Review' }
        )
      ).rejects.toThrow(message)
      expect(
        mocks.request.mock.calls.filter(([method]) => method === 'backlog.execute')
      ).toHaveLength(1)
      expect(executeBacklogOperation).not.toHaveBeenCalled()
    }
  )
  it('refuses an old relay before any write', async () => {
    mocks.mux.mockReturnValue({ request: mocks.request })
    mocks.request.mockResolvedValue({})
    await expect(
      routeBacklogOperation({ ...repo, connectionId: 'remote' }, operation)
    ).rejects.toThrow('Update')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
  it('does not use a nested SSH identity in a different runtime', async () => {
    await expect(
      routeBacklogOperation(
        { ...repo, executionHostId: 'runtime:server', connectionId: 'remote' },
        operation
      )
    ).rejects.toThrow('execution runtime')
    expect(getActiveMultiplexer).not.toHaveBeenCalled()
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
})
