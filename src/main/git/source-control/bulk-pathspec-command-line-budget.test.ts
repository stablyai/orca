import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commandLineLength,
  MAX_COMMAND_LINE_CHARS
} from '../../../shared/windows-command-line-budget'
import { resolveGitCommandWithoutProbe } from '../command-runner/git-command-resolution'

const gitExecFileAsync = vi.fn(async (_args: string[], _options: { stdin?: string }) => ({
  stdout: '',
  stderr: ''
}))

vi.mock('../runner', () => ({
  gitExecFileAsync: (args: string[], options: { stdin?: string }) => gitExecFileAsync(args, options)
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
  const resolved = resolveGitCommandWithoutProbe(
    [...args],
    {
      cwd: wslDistro ? WSL_WORKTREE : '/home/emilio/projects/orca',
      ...(wslDistro ? { wslDistro } : {})
    },
    true
  )
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
  return gitExecFileAsync.mock.calls.map(([args]) => args)
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

  it('stages every path exactly once, in order, through stdin', async () => {
    const { bulkStageFiles } = await import('./staging')
    const filePaths = realisticChangedPaths(250)

    await bulkStageFiles(WSL_WORKTREE, filePaths, { wslDistro: WSL_DISTRO })

    const staged = gitExecFileAsync.mock.calls.flatMap(
      ([, options]) => options.stdin?.split('\0').filter(Boolean) ?? []
    )
    expect(staged).toEqual(filePaths.map((filePath) => `:(literal)${filePath}`))
  })

  it('never widens `clean -ffdx` past the paths it was given', async () => {
    const filePaths = realisticChangedPaths(120)
    const { bulkDiscardChanges } = await import('./discard-changes')

    // Empty ls-files output routes every path to git clean.
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

  it('keeps an over-budget pathspec off argv without dropping it', async () => {
    const { bulkStageFiles } = await import('./staging')
    const hugePath = `src/${'nested-directory/'.repeat(700)}Component.tsx`

    await bulkStageFiles(WSL_WORKTREE, [hugePath, 'src/app.tsx'], { wslDistro: WSL_DISTRO })

    const invocations = capturedInvocations()
    expect(invocations).toEqual([['add', '--pathspec-from-file=-', '--pathspec-file-nul']])
    expect(gitExecFileAsync.mock.calls[0][1].stdin).toBe(
      `:(literal)${hugePath}\0:(literal)src/app.tsx\0`
    )
  })

  it('gives a native Windows git.exe the CreateProcess cap and a POSIX host a larger one', async () => {
    const { bulkPathspecCommands } = await import('./git-pathspec')
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
})
