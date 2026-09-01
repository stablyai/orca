import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRunnerModuleMock } from './status-test-harness'

const { gitExecFileAsyncMock, gitExecFileAsyncBufferMock, gitStreamOptionsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncBufferMock: vi.fn(),
    gitStreamOptionsMock: vi.fn()
  })
)

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

import type { GitSequencerOperation } from '../../shared/git-sequencer-step'
import { continueSequencer } from './sequencer-actions'

const CASES: readonly [GitSequencerOperation, string[]][] = [
  ['merge', ['merge', '--continue']],
  ['rebase', ['rebase', '--continue']],
  ['cherry-pick', ['cherry-pick', '--continue']]
]

// The marker probe runs before the sequencer step, so calls are matched by argv, not index.
function optionsFor(args: readonly string[]): { env?: NodeJS.ProcessEnv } | undefined {
  const call = gitExecFileAsyncMock.mock.calls.find(
    (called: unknown[]) => (called[0] as string[]).join(' ') === args.join(' ')
  )
  return call?.[1] as { env?: NodeJS.ProcessEnv } | undefined
}

function markerProbe(oid: string) {
  return (args: readonly string[]) =>
    args[0] === 'rev-parse'
      ? Promise.resolve({ stdout: `${oid}\n`, stderr: '' })
      : Promise.resolve({ stdout: '', stderr: '' })
}

describe('git sequencer actions', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(markerProbe('abc123'))
  })

  it.each(CASES)('continues a %s with the matching git command', async (operation, args) => {
    await continueSequencer(operation, '/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  // Regression guard: without GIT_EDITOR the `--continue` child waits forever on the commit editor.
  it.each(CASES)('suppresses the commit-message editor for a %s', async (operation, args) => {
    await continueSequencer(operation, '/repo')

    expect(optionsFor(args)?.env?.GIT_EDITOR).toBe('true')
  })

  it('forwards runtime options such as the WSL distro', async () => {
    await continueSequencer('rebase', '/repo', { wslDistro: 'Ubuntu' })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rebase', '--continue'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  // `git rebase --continue` exits nonzero when it lands the resolution and then stops on the
  // NEXT commit's conflict. REBASE_HEAD now names that next commit — the sequencer advancing.
  it('treats a stop on the next commit as progress once the marker has moved', async () => {
    let rebaseHead = 'aaa111'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        expect(args).toEqual(['rev-parse', '-q', '--verify', 'REBASE_HEAD'])
        return Promise.resolve({ stdout: `${rebaseHead}\n`, stderr: '' })
      }
      rebaseHead = 'bbb222'
      return Promise.reject(new Error('error: could not apply ec9b3362... feat: add thing'))
    })

    await expect(continueSequencer('rebase', '/repo')).resolves.toBeUndefined()
  })

  // Git exits 0 once it finishes the sequence, so a cleared marker with a nonzero exit means
  // a hook or post-commit step failed — calling that success would hide it from the user.
  it('surfaces a nonzero exit that cleared the marker instead of reporting completion', async () => {
    let mergeHead: string | null = 'aaa111'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        return mergeHead
          ? Promise.resolve({ stdout: `${mergeHead}\n`, stderr: '' })
          : Promise.reject(new Error('fatal: needed a single revision'))
      }
      mergeHead = null
      return Promise.reject(new Error('post-commit cleanup failed'))
    })

    await expect(continueSequencer('merge', '/repo')).rejects.toThrow('post-commit cleanup failed')
  })

  it('still fails a step that refused to run, leaving the marker where it was', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'rev-parse'
        ? Promise.resolve({ stdout: 'aaa111\n', stderr: '' })
        : Promise.reject(new Error('f.txt: needs merge'))
    )

    await expect(continueSequencer('rebase', '/repo')).rejects.toThrow('needs merge')
  })

  // The whole point of probing the marker instead of HEAD: another actor committing in
  // the worktree moves HEAD but not the sequencer's own ref, so a refused step still fails.
  it('is not fooled by a concurrent commit in the worktree', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'rev-parse'
        ? Promise.resolve({ stdout: 'aaa111\n', stderr: '' })
        : Promise.reject(new Error('f.txt: needs merge'))
    )

    await expect(continueSequencer('rebase', '/repo')).rejects.toThrow('needs merge')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'HEAD'],
      expect.anything()
    )
  })

  // No marker before the step proves nothing ran, so the original failure stands.
  it('rethrows when the marker was already absent', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'rev-parse'
        ? Promise.reject(new Error('fatal: bad revision'))
        : Promise.reject(new Error('cherry-pick failed'))
    )

    await expect(continueSequencer('cherry-pick', '/repo')).rejects.toThrow('cherry-pick failed')
  })
})
