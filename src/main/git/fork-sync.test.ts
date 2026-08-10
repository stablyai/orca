import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { gitSyncForkDefaultBranch } from './fork-sync'

describe('local fork sync SSH policy', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('uses one operation-owned policy cache across every Git step', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === undefined) {
        return { stdout: 'origin\nupstream\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'ls-remote') {
        return { stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return {
          stdout: args[2]?.includes('upstream') ? 'upstream-oid\n' : 'origin-oid\n',
          stderr: ''
        }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0 1\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      gitSyncForkDefaultBranch('/repo', { owner: 'stablyai', repo: 'orca' })
    ).resolves.toMatchObject({ status: 'synced', branchName: 'main' })

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(13)
    const options = gitExecFileAsyncMock.mock.calls.map((call) => call[1])
    const policyCaches = new Set(options.map((value) => value.networkSshPolicyCache))
    expect(policyCaches.size).toBe(1)
    expect(policyCaches.has(undefined)).toBe(false)
    expect(options.every((value) => value.useConfiguredSshCommandForNetwork === true)).toBe(true)
  })
})
