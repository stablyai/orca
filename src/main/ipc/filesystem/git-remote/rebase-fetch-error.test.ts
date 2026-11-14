import { afterEach, expect, it, vi } from 'vitest'

type RebaseHandler = (
  event: unknown,
  args: { worktreePath: string; baseRef: string }
) => Promise<void>

const { handlers, capture } = vi.hoisted(() => ({
  handlers: new Map<string, RebaseHandler>(),
  capture: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: RebaseHandler) => handlers.set(channel, handler) }
}))
vi.mock('../../../git/command-runner/process-capture/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('../../../../shared/git/fetch/git-fetch-head-lock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithGitFetchHeadLock: (_cwd: string, _signal: AbortSignal | undefined, run: () => unknown) =>
    run()
}))
vi.mock('../../../../shared/git/worktrees/git-worktree-operation-lock', () => ({
  runWithGitWorktreeOperationLock: (
    _cwd: string,
    _signal: AbortSignal | undefined,
    run: () => unknown
  ) => run()
}))

import { registerGitRemoteBranchMutationHandlers } from './branch-mutation-handlers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('surfaces the fetch diagnostic and retry guidance through the rebase IPC handler', async () => {
  vi.useFakeTimers()
  vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
  const original = Object.assign(
    new Error('error: fetching ref refs/remotes/origin/main failed: incorrect old value provided'),
    {
      code: 1,
      stderr: 'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided'
    }
  )
  capture.mockImplementation((_command, args, options) => {
    options.onChildTerminated()
    if (args[0] === 'fetch') {
      return Promise.reject(original)
    }
    return Promise.resolve({ stdout: args[0] === 'remote' ? 'origin\n' : '', stderr: '' })
  })
  const store = {
    getRepos: () => [{ id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler only reads getRepos and checks optional runtime accessors.
  registerGitRemoteBranchMutationHandlers({ store } as never)
  const result = handlers.get('git:rebaseFromBase')!(null, {
    worktreePath: '/repo',
    baseRef: 'origin/main'
  })
  const rejection = expect(result).rejects.toMatchObject({
    message: expect.stringMatching(
      /fetching ref refs\/remotes\/origin\/main failed: incorrect old value provided[\s\S]+Another Git process updated remote references\. Try again\./
    ),
    cause: expect.objectContaining({ cause: original })
  })
  await vi.runAllTimersAsync()
  await rejection
})
