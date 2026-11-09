import { expect, it, vi } from 'vitest'
import { fixture, io } from './terminal-model-discovery.test-fixture'
import { readFloatingTerminalCwd } from '../floating-workspace-directory'

it.each([3, 30])(
  'discovery of %i deferred fork scopes submits no preparation jobs or writes',
  async (count) => {
    const rig = fixture({ repo: true, deferred: true, unstamped: true })
    io.rows = Array.from({ length: count }, (_unused, index) => ({
      path: `C:\\fork-${index}`,
      head: 'abc',
      branch: 'fix',
      isBare: false,
      isMainWorktree: index === 0
    }))
    for (const row of io.rows) {
      await rig.runtime.discoverTerminalModels(`path:${row.path}`, 'antigravity')
    }
    await rig.runtime.discoverTerminalModels('path:C:\\fork-0', 'antigravity')
    io.discover.mockResolvedValueOnce({ success: false, error: 'offline' })
    await rig.runtime.discoverTerminalModels('path:C:\\fork-0', 'antigravity')
    await Promise.resolve()
    expect(io.materialize.mock.calls).toEqual([])
    expect(io.mutations.mock.calls).toEqual([])
    expect(io.userAct.mock.calls).toEqual([])
    // The real launch wrapper still prepares this exact registered deferred fork.
    await rig.runtime.resolveTerminalWorkspaceLaunchScope('path:C:\\fork-0')
    expect(io.materialize).toHaveBeenCalledWith(
      'C:\\fork-0',
      {
        remote: 'contributor',
        branch: 'fix',
        remoteCreated: false,
        remoteUrl: 'https://example.com/contributor/repo.git'
      },
      expect.anything(),
      'repo',
      {},
      expect.anything()
    )
  }
)

it('read-only floating selection never creates or trusts a missing fallback directory', async () => {
  fixture()
  // Filesystem failure is the external boundary, not a replacement scope policy.
  const spy = vi
    .spyOn(await import('node:fs/promises'), 'stat')
    .mockRejectedValue(new Error('ENOENT'))
  await expect(
    readFloatingTerminalCwd({ getSettings: () => ({}) }, { path: '/missing' })
  ).rejects.toThrow('floating_workspace_path_unavailable')
  expect(io.mutations).not.toHaveBeenCalled()
  spy.mockRestore()
})
