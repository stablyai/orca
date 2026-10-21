/**
 * `repo.gitAvailable` gates the create dialog's Git option on a runtime/remote host. Only a spawn
 * that never started may answer `false`; everything else rejects so the renderer's existing
 * `unknown` branch stays reachable instead of collapsing to a false "no Git here".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'

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
})
