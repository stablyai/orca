import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as WslUncAccessGate from '../wsl/wsl-unc-access-gate'

const mocks = vi.hoisted(() => ({
  realpath: vi.fn(async (path: string) => path),
  blocked: vi.fn<typeof WslUncAccessGate.blockedWslDistroForPath>(async () => null)
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  realpath: mocks.realpath
}))
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGate>()),
  blockedWslDistroForPath: mocks.blocked
}))

import { resolveWorkspacePortProbes } from './local-workspace-port-attribution'
import type { WorkspacePortProbe } from '../../shared/workspace-ports'

function probe(path: string): WorkspacePortProbe {
  return { id: `wt:${path}`, repoId: 'repo-1', displayName: 'repo', path }
}

describe('port attribution for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    mocks.realpath.mockClear()
    mocks.blocked.mockReset().mockResolvedValue(null)
  })

  it("never realpaths a stopped distro's workspace root, leaving its alias unknown", async () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })

    const result = await resolveWorkspacePortProbes([probe(root)], true)

    expect(mocks.blocked).toHaveBeenCalledWith(root)
    expect(mocks.realpath).not.toHaveBeenCalled()
    expect(result.complete).toBe(false)
  })

  it('resolves roots whose distro runs, and host roots, as before', async () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\other'

    const result = await resolveWorkspacePortProbes([probe(root), probe('C:\\src\\repo')], true)

    expect(mocks.realpath).toHaveBeenCalledWith(root)
    expect(mocks.realpath).toHaveBeenCalledWith('C:\\src\\repo')
    expect(result.complete).toBe(true)
  })
})
