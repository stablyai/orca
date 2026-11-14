import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import type * as CliCommandResolution from '../../../shared/node-cli-command-resolution'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverCommitMessageModelsLocal } from '../commit-message-text-generation'
import {
  answerCodexAppServer,
  createMockDiscoveryChild
} from '../execution/commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

// These protocol fixtures use fake processes; installed host CLIs belong to the CLI-path suite.
vi.mock('../../../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof CliCommandResolution>()),
  resolveCliCommand: (command: string) => command
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

// Fake Windows direct-child/taskkill paths here; source-control-local-process.test.ts covers supervised POSIX stop and managed-home lock release.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: hostPlatform
  })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32'
  })
  // Clear PATH so host agent installs cannot answer fake Windows lookups.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('discoverCommitMessageModelsLocal on the Windows direct-child path', () => {
  it('releases the Codex home after a discovery timeout once the child exits', async () => {
    vi.useFakeTimers()
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: '/managed/codex-discovery-descendant-home' }

    try {
      const first = discoverCommitMessageModelsLocal('codex', env)
      await vi.advanceTimersByTimeAsync(0)
      // A different command shares the home lock but not the in-flight listing.
      const second = discoverCommitMessageModelsLocal('codex', env, 'codex')
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(first).resolves.toMatchObject({ success: false })
      expect(spawnMock).toHaveBeenCalledTimes(1)

      // Inherited stdout can outlive the killed root; exit must suffice without close.
      firstChild.emit('exit', null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnMock).toHaveBeenCalledTimes(2)

      answerCodexAppServer(secondChild, [
        { data: [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' }], nextCursor: null }
      ])
      await expect(second).resolves.toMatchObject({
        success: true,
        defaultModelId: 'gpt-5.5'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
