import { describe, expect, it, vi } from 'vitest'

const read = vi.hoisted(() => vi.fn(async () => ({ volumes: [], checkedAt: 1 })))
vi.mock('../../../../orcad/orcad-disk-usage', () => ({ readOrcadDiskUsage: read }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  homedir: () => '/home/user'
}))

import { ORCAD_DISK_USAGE_METHODS, orcadDiskUsageProbePaths } from './orcad-disk-usage-method'
import { ORCAD_DISK_USAGE_METHOD } from '../../../../../shared/orcad-disk-usage'

describe('orcad.diskUsage', () => {
  it('registers under the shared name with workspace permission', () => {
    expect(ORCAD_DISK_USAGE_METHODS[0]!.name).toBe(ORCAD_DISK_USAGE_METHOD)
    expect(ORCAD_DISK_USAGE_METHODS[0]!.permission).toBe('workspace')
  })

  it('probes the workspace dir, local repos and home', async () => {
    const runtime = {
      requireStore: () => ({
        getSettings: () => ({ workspaceDir: '/vercel/sandbox/workspaces' }),
        getRepos: () => [
          { path: '/vercel/sandbox/app', connectionId: null },
          { path: '/remote/repo', connectionId: 'ssh-1' }
        ]
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the store members faked above.
    const result = await ORCAD_DISK_USAGE_METHODS[0]!.handler({} as never, { runtime } as never)
    expect(result).toEqual({ volumes: [], checkedAt: 1 })
    expect(read).toHaveBeenCalledWith([
      '/vercel/sandbox/workspaces',
      '/vercel/sandbox/app',
      '/home/user'
    ])
  })
})

describe('orcadDiskUsageProbePaths', () => {
  it('drops SSH, runtime-owned and relative repos', () => {
    expect(
      orcadDiskUsageProbePaths({
        workspaceDir: null,
        repos: [
          { path: '/a', connectionId: null, executionHostId: 'local' },
          { path: '/b', connectionId: 'ssh-1' },
          { path: '/c', executionHostId: 'runtime:env-1' },
          { path: 'relative' }
        ],
        home: '/home/user'
      })
    ).toEqual(['/a', '/home/user'])
  })
})
