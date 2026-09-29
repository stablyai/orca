/**
 * `repo.gitAvailable` gates the create dialog's Git option on a runtime/remote host. Only a spawn
 * that never started may answer `false`; everything else rejects so the renderer's existing
 * `unknown` branch stays reachable instead of collapsing to a false "no Git here".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'

function spawnEnoent(): Error {
  return Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', syscall: 'spawn git' })
}

describe('RuntimeServerEnvironmentCommands.isGitAvailable', () => {
  const commands = new RuntimeServerEnvironmentCommands()

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers true when git reports its version', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git version 2.25.1\n', stderr: '' })
    await expect(commands.isGitAvailable()).resolves.toBe(true)
  })

  it('answers false only when the spawn itself found no binary', async () => {
    gitExecFileAsyncMock.mockRejectedValue(spawnEnoent())
    await expect(commands.isGitAvailable()).resolves.toBe(false)
  })

  it('rejects an ENOENT when the working directory disappeared', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(`${process.cwd()}-missing`)
    gitExecFileAsyncMock.mockRejectedValue(spawnEnoent())
    await expect(commands.isGitAvailable()).rejects.toThrow('spawn git ENOENT')
  })

  it('rejects a slow host rather than reporting no Git', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('git --version timed out after 3000ms'))
    await expect(commands.isGitAvailable()).rejects.toThrow('timed out')
  })

  it('rejects a repository-level git failure rather than reporting no Git', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('detected dubious ownership'), { code: 128 })
    )
    await expect(commands.isGitAvailable()).rejects.toThrow('dubious ownership')
  })
})
