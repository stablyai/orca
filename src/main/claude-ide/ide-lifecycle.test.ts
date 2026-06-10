import { describe, it, expect, vi } from 'vitest'
import { IdeLifecycle } from './ide-lifecycle'

describe('IdeLifecycle', () => {
  it('starts a server + lockfile on worktree open and tears down on close', async () => {
    const writeLockfile = vi.fn()
    const removeLockfile = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    const startIdeServer = vi.fn().mockResolvedValue({ port: 4001, close })
    const life = new IdeLifecycle({
      ideDir: '/ide', startIdeServer, writeLockfile, removeLockfile,
      send: vi.fn(), pid: 123, runningInWindows: false,
    })

    await life.onWorktreeOpen('wt-a', '/path/wt-a')
    expect(startIdeServer).toHaveBeenCalled()
    expect(writeLockfile).toHaveBeenCalledWith('/ide', 4001, expect.objectContaining({ workspaceFolders: ['/path/wt-a'] }))

    await life.onWorktreeClose('wt-a')
    expect(close).toHaveBeenCalled()
    expect(removeLockfile).toHaveBeenCalledWith('/ide', 4001)
  })

  it('onWorktreeOpen is idempotent — startIdeServer and writeLockfile called only once', async () => {
    const writeLockfile = vi.fn()
    const startIdeServer = vi.fn().mockResolvedValue({ port: 4001, close: vi.fn() })
    const life = new IdeLifecycle({
      ideDir: '/ide', startIdeServer, writeLockfile, removeLockfile: vi.fn(),
      send: vi.fn(), pid: 123, runningInWindows: false,
    })
    await life.onWorktreeOpen('wt-a', '/path/wt-a')
    await life.onWorktreeOpen('wt-a', '/path/wt-a')
    expect(startIdeServer).toHaveBeenCalledTimes(1)
    expect(writeLockfile).toHaveBeenCalledTimes(1)
  })

  it('exposes the env vars to inject for a worktree', async () => {
    const life = new IdeLifecycle({
      ideDir: '/ide',
      startIdeServer: vi.fn().mockResolvedValue({ port: 4042, close: vi.fn() }),
      writeLockfile: vi.fn(), removeLockfile: vi.fn(), send: vi.fn(), pid: 1, runningInWindows: false,
    })
    await life.onWorktreeOpen('wt-a', '/path/wt-a')
    expect(life.envForWorktree('wt-a')).toEqual({
      CLAUDE_CODE_SSE_PORT: '4042',
      ENABLE_IDE_INTEGRATION: 'true',
    })
  })
})
