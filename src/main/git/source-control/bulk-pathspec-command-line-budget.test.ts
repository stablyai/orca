import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS
} from '../../../shared/windows-command-line-budget'
import { resolveGitCommandWithoutProbe } from '../command-runner/git-command-resolution'

const gitExecFileAsync = vi.fn(async () => ({ stdout: '', stderr: '' }))

vi.mock('../runner', () => ({
  gitExecFileAsync: (...args: unknown[]) =>
    (gitExecFileAsync as unknown as (...a: unknown[]) => Promise<{ stdout: string }>)(...args)
}))
vi.mock('./git-read-cache-invalidation', () => ({ invalidateGitReadCaches: vi.fn() }))
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

const WSL_DISTRO = 'Ubuntu-24.04'
const WSL_WORKTREE = `\\\\wsl$\\${WSL_DISTRO}\\home\\emilio\\projects\\orca`

/** Windows-side length of the line `wsl.exe` is spawned with, wrapper included. */
function finishedCommandLineLength(args: readonly string[], wslDistro?: string): number {
  const resolved = resolveGitCommandWithoutProbe([...args], {
    cwd: wslDistro ? WSL_WORKTREE : '/home/emilio/projects/orca',
    ...(wslDistro ? { wslDistro } : {})
  })
  return commandLineLength([resolved.binary, ...resolved.args])
}

/** Deep nesting, a space, and non-ASCII: all three inflate the quoted line. */
function realisticChangedPaths(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `apps/web/src/components/dashboard/widgets/analytics/rapport trimestriel ${String(index).padStart(3, '0')}/données-générales/AnalyticsSummaryWidget${index}.tsx`
  )
}

function capturedInvocations(): string[][] {
  return gitExecFileAsync.mock.calls.map((call) => (call as unknown as [string[]])[0])
}

describe('bulk pathspec command-line budget', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    gitExecFileAsync.mockReset()
    gitExecFileAsync.mockImplementation(async () => ({ stdout: '', stderr: '' }))
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    vi.resetModules()
  })

  it('keeps every WSL bulk-stage invocation inside the Windows command-line cap', async () => {
    const { bulkStageFiles } = await import('./staging')
    const filePaths = realisticChangedPaths(100)

    await bulkStageFiles(WSL_WORKTREE, filePaths, { wslDistro: WSL_DISTRO })

    const invocations = capturedInvocations()
    expect(invocations.length).toBeGreaterThan(0)
    const lengths = invocations.map((args) => finishedCommandLineLength(args, WSL_DISTRO))
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
  })

  it('stages every path exactly once, in order, across the chunks', async () => {
    const { bulkStageFiles } = await import('./staging')
    const filePaths = realisticChangedPaths(250)

    await bulkStageFiles(WSL_WORKTREE, filePaths, { wslDistro: WSL_DISTRO })

    const staged = capturedInvocations().flatMap((args) => args.slice(args.indexOf('--') + 1))
    expect(staged).toEqual(filePaths.map((filePath) => `:(literal)${filePath}`))
  })

  it('keeps WSL bulk unstage inside the cap', async () => {
    const { bulkUnstageFiles } = await import('./staging')

    await bulkUnstageFiles(WSL_WORKTREE, realisticChangedPaths(100), { wslDistro: WSL_DISTRO })

    const lengths = capturedInvocations().map((args) => finishedCommandLineLength(args, WSL_DISTRO))
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
  })

  it('never emits a pathspec-free chunk, which would widen `clean -ffdx` to the worktree', async () => {
    const { bulkStageFiles } = await import('./staging')

    await bulkStageFiles(WSL_WORKTREE, realisticChangedPaths(300), { wslDistro: WSL_DISTRO })

    for (const args of capturedInvocations()) {
      expect(args.slice(args.indexOf('--') + 1).length).toBeGreaterThan(0)
    }
  })

  it('splits a WSL bulk discard of tracked paths into spawnable restores', async () => {
    const filePaths = realisticChangedPaths(120)
    gitExecFileAsync.mockImplementation(async () => ({ stdout: filePaths.join('\0'), stderr: '' }))
    const { bulkDiscardChanges } = await import('./discard-changes')

    await bulkDiscardChanges(WSL_WORKTREE, filePaths, { wslDistro: WSL_DISTRO })

    const restores = capturedInvocations().filter((args) => args[0] === 'restore')
    expect(restores.length).toBeGreaterThan(1)
    for (const args of restores) {
      expect(finishedCommandLineLength(args, WSL_DISTRO)).toBeLessThanOrEqual(
        MAX_COMMAND_LINE_CHARS
      )
    }
  })

  it('never widens `clean -ffdx` past the paths it was given', async () => {
    const filePaths = realisticChangedPaths(120)
    const { bulkDiscardChanges } = await import('./discard-changes')

    // Empty ls-files output: every path is untracked, so all of them take the clean lane.
    await bulkDiscardChanges(WSL_WORKTREE, filePaths, { wslDistro: WSL_DISTRO })

    const cleans = capturedInvocations().filter((args) => args[0] === 'clean')
    expect(cleans.length).toBeGreaterThan(1)
    const cleaned = cleans.flatMap((args) => args.slice(args.indexOf('--') + 1))
    expect(cleaned).toEqual(filePaths.map((filePath) => `:(literal)${filePath}`))
    for (const args of cleans) {
      expect(finishedCommandLineLength(args, WSL_DISTRO)).toBeLessThanOrEqual(
        MAX_COMMAND_LINE_CHARS
      )
    }
  })

  it('ships a single over-budget pathspec alone rather than dropping it', async () => {
    const { bulkStageFiles } = await import('./staging')
    const hugePath = `src/${'nested-directory/'.repeat(700)}Component.tsx`

    await bulkStageFiles(WSL_WORKTREE, [hugePath, 'src/app.tsx'], { wslDistro: WSL_DISTRO })

    const invocations = capturedInvocations()
    expect(invocations).toHaveLength(2)
    expect(invocations[0]).toEqual(['add', '--', `:(literal)${hugePath}`])
    expect(invocations[1]).toEqual(['add', '--', ':(literal)src/app.tsx'])
  })

  it('packs chunks to the budget instead of splitting timidly', async () => {
    const { bulkStageFiles } = await import('./staging')

    await bulkStageFiles(WSL_WORKTREE, realisticChangedPaths(100), { wslDistro: WSL_DISTRO })

    const lengths = capturedInvocations().map((args) => finishedCommandLineLength(args, WSL_DISTRO))
    // Every chunk but the last is filled to within one pathspec of the cap.
    expect(Math.min(...lengths.slice(0, -1))).toBeGreaterThan(MAX_COMMAND_LINE_CHARS * 0.9)
  })

  it('gives a native Windows git.exe the CreateProcess cap and a POSIX host a larger one', async () => {
    const { bulkPathspecCommands } = await import('./git-pathspec')
    // Long enough that the raw argv alone passes the Windows cap with no wrapper in sight.
    const filePaths = Array.from(
      { length: 100 },
      (_, index) => `packages/${'deeply-nested-module/'.repeat(18)}file-${index}.ts`
    )

    const windowsNative = bulkPathspecCommands(['add', '--'], filePaths, 'C:\\repo', {})
    expect(windowsNative.length).toBeGreaterThan(1)
    for (const args of windowsNative) {
      expect(finishedCommandLineLength(args)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
    }

    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(bulkPathspecCommands(['add', '--'], filePaths, '/repo', {})).toHaveLength(1)
  })

  it('does not charge a native invocation for the WSL wrapper', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { bulkStageFiles } = await import('./staging')

    await bulkStageFiles('/home/emilio/projects/orca', realisticChangedPaths(100))

    // Same 100 paths that need several chunks under the WSL wrapper stay one native call.
    expect(capturedInvocations()).toHaveLength(1)
  })
})
