import { beforeEach, expect, it, vi } from 'vitest'
import { resolveBranchSwitchTarget } from './branch-switch-target'
import { gitExecFileAsync } from './runner'
vi.mock('./runner', () => ({ gitExecFileAsync: vi.fn() }))
beforeEach(() => vi.mocked(gitExecFileAsync).mockReset())
it('explains how to recover when remote settings cannot be read', async () => {
  vi.mocked(gitExecFileAsync)
    .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/topic\t\t\n', stderr: '' })
    .mockRejectedValueOnce(new Error('raw remote command failure'))
  await expect(
    resolveBranchSwitchTarget('/repo', { kind: 'remote', name: 'origin/topic' }, {})
  ).rejects.toThrow(
    "Orca couldn't read this repository's remotes. Check its remote settings in a terminal, then try again."
  )
})
