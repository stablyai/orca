import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))
vi.mock('../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))
vi.mock('./git-read-cache-invalidation', () => ({ invalidateGitReadCaches: vi.fn() }))
// Stand in for the on-disk safety filter: every discard target here exists and is symlink-free.
vi.mock('../../../shared/git-discard-path-safety', () => ({
  removeSafeUntrackedDiscardTarget: vi.fn(),
  removeSafeUntrackedDiscardTargets: async (
    _worktreePath: string,
    untrackedPaths: string[],
    cleanUntracked: (paths: string[]) => Promise<void>,
    restoreTracked: () => Promise<void>
  ) => {
    await restoreTracked()
    if (untrackedPaths.length > 0) {
      await cleanUntracked(untrackedPaths)
    }
  }
}))

import { bulkDiscardChanges } from './discard-changes'
import { resetWslGitReadEnvironmentForTests } from '../wsl-git-read-environment'

const DISTRO = 'Ubuntu-24.04'
const WSL_WORKTREE = `\\\\wsl$\\${DISTRO}\\home\\emilio\\projects\\orca`
const TRACKED_PATHS = ['docs/architecture.md', 'src/main/git/runner.ts']
// Stock Ubuntu writes this to *stdout* from the interactive login shell's rc.
const BANNER = 'To run a command as administrator (user "root"), use "sudo <command>".\n\n'

type MockChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

function guestScript(args: unknown): string {
  return (args as string[] | undefined)?.join(' ') ?? ''
}

/** Wrap the payload in the caller's own fence when it asked for one; otherwise hand it over raw. */
function loginShellStdout(script: string, payload: string): string {
  const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(script)?.[1]
  return nonce
    ? `${BANNER}__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
    : `${BANNER}${payload}`
}

function gitCommandLines(): string[] {
  return execFileMock.mock.calls
    .map((call) => guestScript(call[1]))
    .filter((script) => !script.includes('_orca_git_path='))
}

describe('WSL tracked-path listing behind a login-shell banner', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    resetWslGitReadEnvironmentForTests()
    execFileMock.mockReset()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      const script = guestScript(args)
      if (script.includes('_orca_git_path=')) {
        // Distro exports GIT_* / XDG_CONFIG_HOME, so the direct-git read probe is rejected for good.
        queueMicrotask(() => callback?.(Object.assign(new Error('probe rejected'), { code: 78 })))
        return createMockChild()
      }
      const payload = script.includes('ls-files') ? `${TRACKED_PATHS.join('\0')}\0` : ''
      queueMicrotask(() => callback?.(null, loginShellStdout(script, payload), ''))
      return createMockChild()
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform })
    resetWslGitReadEnvironmentForTests()
  })

  it('restores every tracked path instead of routing the first one to git clean', async () => {
    await bulkDiscardChanges(WSL_WORKTREE, [...TRACKED_PATHS], { wslDistro: DISTRO })

    const commandLines = gitCommandLines()
    expect(commandLines.filter((line) => line.includes('clean'))).toEqual([])
    const restored = commandLines.filter((line) => line.includes('restore'))
    expect(restored.length).toBeGreaterThan(0)
    for (const trackedPath of TRACKED_PATHS) {
      expect(restored.some((line) => line.includes(`:(literal)${trackedPath}`))).toBe(true)
    }
  })
})
