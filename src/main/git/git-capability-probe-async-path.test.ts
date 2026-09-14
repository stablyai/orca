import type * as RunProcess from '../../shared/child-process/run-process'
import type * as GitRunner from './runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, runProcessSyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  runProcessSyncMock: vi.fn(() => ({
    code: 0,
    signal: null,
    stdout: 'ok\n',
    stderr: '',
    timedOut: false
  }))
}))

// Why the process layer and not node:child_process: the whole point of the
// conversion is that git no longer reaches child_process itself, so the ratchet
// has to watch the sanctioned runner instead.
vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcess>()),
  runProcessSync: runProcessSyncMock
}))

vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { searchBaseRefs } from './repo'
import { gitExecFileSync } from './runner'

describe('git command path stays off the sync spawn API', () => {
  afterEach(() => {
    clearGitCapabilityStateForTests()
    gitExecFileAsyncMock.mockReset()
    runProcessSyncMock.mockClear()
  })

  it('probes an unsupported capability once and never spawns synchronously', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args.some((arg) => arg.startsWith('--exclude=refs/remotes/'))) {
        throw Object.assign(new Error("unknown option `exclude'"), {
          stderr: "error: unknown option `exclude'"
        })
      }
      return { stdout: 'refs/remotes/origin/main\0origin/main', stderr: '' }
    })

    await expect(searchBaseRefs('/repo', '', 1)).resolves.toEqual(['origin/main'])
    await expect(searchBaseRefs('/repo', '', 1)).resolves.toEqual(['origin/main'])

    // GitCapabilityCache remembers the unsupported `--exclude`, so the second
    // search reuses that verdict instead of re-probing the preferred form.
    const preferredProbes = gitExecFileAsyncMock.mock.calls.filter((call) =>
      (call[0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    )
    expect(preferredProbes).toHaveLength(1)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('routes the remaining sync runner through the sanctioned process API', () => {
    expect(gitExecFileSync(['rev-parse', '--git-path', 'orca'], { cwd: '/repo' })).toBe('ok\n')
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['rev-parse', '--git-path', 'orca'], cwd: '/repo' })
    )
  })

  it('throws on a non-zero exit so catch-based callers keep their fallback', () => {
    runProcessSyncMock.mockReturnValueOnce({
      code: 128,
      signal: null,
      stdout: '',
      stderr: 'fatal: not a git repository\n',
      timedOut: false
    })

    expect(() => gitExecFileSync(['rev-parse', '--git-dir'], { cwd: '/repo' })).toThrow(
      /fatal: not a git repository/
    )
  })
})
