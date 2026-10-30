import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  read: vi.fn(),
  write: vi.fn(async () => undefined),
  broadcast: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../issue-command-file', () => ({
  readIssueCommandUnlessWslStopped: mocks.read,
  writeIssueCommandUnlessWslStopped: mocks.write
}))
vi.mock('../preflight-wsl-refusal-retry', () => ({
  broadcastWhenWslDistroRunning: mocks.broadcast
}))
vi.mock('../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../../persistence/moving-wsl-projects/wsl-move-scope-guard', () => ({
  assertWslMoveRepoWritable: () => undefined
}))

import { registerWorktreeHookFileHandlers } from './register-worktree-hook-file-handlers'

const REPO = { id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\repo', kind: 'git' }

function call(channel: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`${channel} is not registered`)
  }
  return handler(null, { repoId: REPO.id, ...args })
}

describe('hooks issue-command IPC for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.read.mockReset()
    mocks.write.mockClear()
    mocks.broadcast.mockClear()
    const store = { getRepos: () => [REPO], getRepo: () => REPO }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these store accessors.
    registerWorktreeHookFileHandlers({ store } as never)
  })

  it('asks main to signal the editor once the refusing distro runs', async () => {
    mocks.read.mockResolvedValue({ status: 'error', refusedWslDistro: 'Ubuntu' })
    await call('hooks:readIssueCommand', {})
    expect(mocks.broadcast).toHaveBeenCalledWith('Ubuntu', 'issue-command:repo-1')
  })

  it('does not wait on a read that answered', async () => {
    mocks.read.mockResolvedValue({ localContent: 'x', source: 'local' })
    await call('hooks:readIssueCommand', {})
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it("passes a save's user act through to the gated write", async () => {
    await call('hooks:writeIssueCommand', { content: 'mine', wakeWslDistro: true })
    expect(mocks.write).toHaveBeenCalledWith(REPO.path, 'mine', expect.any(Function), {
      wakeWslDistro: true
    })
  })
})
