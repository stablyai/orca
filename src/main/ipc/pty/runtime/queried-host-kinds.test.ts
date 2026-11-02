import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProcessesWithHostScopeFromRuntimeController } from './inventory-operations'
import { localProvider } from '../provider/registry'

afterEach(() => vi.restoreAllMocks())

describe('the hosts a PTY inventory can report having queried', () => {
  it('reports the local query results and propagates a failed query', async () => {
    const listProcesses = vi
      .spyOn(localProvider, 'listProcesses')
      .mockResolvedValue([{ id: 'pty-local', cwd: '/workspace', title: 'Local terminal' }])

    expect(await listProcessesWithHostScopeFromRuntimeController({})).toEqual({
      processes: [{ id: 'pty-local', cwd: '/workspace', title: 'Local terminal' }],
      hostIds: ['local']
    })
    expect(listProcesses).toHaveBeenCalledOnce()

    listProcesses.mockRejectedValueOnce(new Error('Local inventory unavailable'))
    await expect(listProcessesWithHostScopeFromRuntimeController({})).rejects.toThrow(
      'Local inventory unavailable'
    )
  })
})
