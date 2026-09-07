import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

function spawnCwd(callIndex = 0): string {
  return (mockPtySpawn.mock.calls[callIndex][2] as { cwd: string }).cwd
}

describe('relay pty spawn cwd (#15296)', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let root: string

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    root = mkdtempSync(join(tmpdir(), 'orca-relay-cwd-'))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    rmSync(root, { recursive: true, force: true })
  })

  it('spawns a folder workspace in ORCA_WORKSPACE_ROOT instead of the host default', async () => {
    // Why: `folder:<uuid>` carries no path, so the worktree-id split yields nothing and the
    // configured root — delivered in the same env — was silently replaced by $HOME.
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(workspaceRoot)
    const workspaceId = 'folder:b1706d92-9d05-4932-8360-01e00b54305a'

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      env: {
        ORCA_WORKSPACE_ID: workspaceId,
        ORCA_WORKTREE_ID: workspaceId,
        ORCA_WORKSPACE_ROOT: workspaceRoot
      }
    })

    expect(spawnCwd()).toBe(workspaceRoot)
    expect(spawnCwd()).not.toBe(homedir())
  })

  it('refuses to launch an agent when the named workspace root is not on this host', async () => {
    const workspaceId = 'folder:b1706d92-9d05-4932-8360-01e00b54305a'

    await expect(
      dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        env: {
          ORCA_WORKSPACE_ID: workspaceId,
          ORCA_WORKTREE_ID: workspaceId,
          ORCA_WORKSPACE_ROOT: join(root, 'gone')
        }
      })
    ).rejects.toThrow(/Cannot determine the working directory/)
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('refuses to launch an agent for a folder workspace that carries no root at all', async () => {
    await expect(
      dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        env: { ORCA_WORKTREE_ID: 'folder:b1706d92-9d05-4932-8360-01e00b54305a' }
      })
    ).rejects.toThrow(/Cannot determine the working directory/)
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('falls back to the worktree path carried by the worktree id', async () => {
    const worktreePath = join(root, 'checkout')
    mkdirSync(worktreePath)

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      worktreeId: `repo-1::${worktreePath}`
    })

    expect(spawnCwd()).toBe(worktreePath)
  })

  it('keeps an explicitly requested cwd verbatim', async () => {
    const workspaceRoot = join(root, 'workspace')
    const requested = join(root, 'workspace', 'sub')
    mkdirSync(requested, { recursive: true })

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: requested,
      env: { ORCA_WORKTREE_ID: 'folder:abc', ORCA_WORKSPACE_ROOT: workspaceRoot }
    })

    expect(spawnCwd()).toBe(requested)
  })

  it('still uses the host default for a terminal that names no workspace', async () => {
    await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })

    expect(spawnCwd()).toBe(process.env.HOME || homedir())
  })

  it('does not refuse a plain shell whose workspace root is missing', async () => {
    const missing = join(root, 'gone')

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      env: { ORCA_WORKTREE_ID: 'folder:abc', ORCA_WORKSPACE_ROOT: missing }
    })

    expect(spawnCwd()).toBe(process.env.HOME || homedir())
  })
})

describe('relay pty spawn cwd when the relay is not the execution host', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let root: string

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    root = mkdtempSync(join(tmpdir(), 'orca-relay-wsl-cwd-'))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    rmSync(root, { recursive: true, force: true })
  })

  // The relay supports WSL shells, and relayHostDirectoryExists stats the relay's own filesystem.
  // A guest path never stats on a Windows relay, so refusing there would fail an agent launch the
  // launch wrapper would have cd'd into fine -- the same host pair the worktree branch already
  // treats as a miss rather than a refusal.
  it('does not refuse an agent whose folder-workspace root lives in the WSL guest', async () => {
    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      shellOverride: 'wsl.exe',
      env: {
        ORCA_WORKSPACE_ID: 'folder:b1706d92-9d05-4932-8360-01e00b54305a',
        ORCA_WORKTREE_ID: 'folder:b1706d92-9d05-4932-8360-01e00b54305a',
        ORCA_WORKSPACE_ROOT: '/home/u/guest-only-project'
      }
    })

    expect(mockPtySpawn).toHaveBeenCalled()
  })

  it('still refuses when the same spawn runs on the relay filesystem itself', async () => {
    await expect(
      dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        launchAgent: 'claude',
        shellOverride: 'powershell.exe',
        env: {
          ORCA_WORKSPACE_ID: 'folder:b1706d92-9d05-4932-8360-01e00b54305a',
          ORCA_WORKTREE_ID: 'folder:b1706d92-9d05-4932-8360-01e00b54305a',
          ORCA_WORKSPACE_ROOT: join(root, 'gone')
        }
      })
    ).rejects.toThrow(/Cannot determine the working directory/)
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })
})
