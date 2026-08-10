import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runRelayGitRemoteCommandMock } = vi.hoisted(() => ({
  runRelayGitRemoteCommandMock: vi.fn()
}))

vi.mock('./relay-git-remote-command', () => ({
  runRelayGitRemoteCommand: runRelayGitRemoteCommandMock
}))

import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

type RemotePreparationGit = {
  remotePreparationGit(
    args: string[],
    cwd: string,
    context: { deadline: { expiresAtMs: number }; signal: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>
}

describe('relay remote Git preparation deadline', () => {
  beforeEach(() => {
    runRelayGitRemoteCommandMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('propagates the operation cleanup deadline to preparatory Git', async () => {
    const handler = new GitHandler(
      createMockDispatcher() as unknown as RelayDispatcher,
      new RelayContext()
    ) as unknown as RemotePreparationGit
    const controller = new AbortController()
    const context = {
      deadline: { expiresAtMs: 5_100 },
      signal: controller.signal
    }

    await handler.remotePreparationGit(['remote'], '/repo', context)

    expect(runRelayGitRemoteCommandMock).toHaveBeenCalledWith(
      ['remote'],
      expect.objectContaining({ cleanupDeadlineMs: context.deadline.expiresAtMs })
    )
  })
})
