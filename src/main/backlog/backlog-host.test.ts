import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { routeBacklogOperation } from './backlog-host'
import { executeBacklogOperation } from './backlog-service'

vi.mock('./backlog-service', () => ({ executeBacklogOperation: vi.fn() }))
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
  })
  it('serves a runtime-stamped row from this runtime’s own Store on this host', async () => {
    await routeBacklogOperation({ ...repo, executionHostId: 'runtime:server' }, operation)
    expect(executeBacklogOperation).toHaveBeenCalledWith('/project', operation)
  })
  it.each([
    ['legacy connectionId', { connectionId: 'remote' }],
    ['unified ssh host', { executionHostId: 'ssh:remote' as const }],
    [
      'nested SSH identity beside a runtime stamp',
      {
        executionHostId: 'runtime:server' as const,
        connectionId: 'remote'
      }
    ]
  ])('refuses an unserved %s without reading local files', async (_label, host) => {
    expect(() => routeBacklogOperation({ ...repo, ...host }, operation)).toThrow(
      'Tasks will not be read locally'
    )
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
  it('refuses an unserved SSH mutation before any CLI execution', () => {
    expect(() =>
      routeBacklogOperation(
        { ...repo, executionHostId: 'ssh:remote' },
        { kind: 'create', title: 'Task', description: '', status: 'Review' }
      )
    ).toThrow('Reconnect the SSH host')
    expect(executeBacklogOperation).not.toHaveBeenCalled()
  })
})
