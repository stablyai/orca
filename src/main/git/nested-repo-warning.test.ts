import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NestedRepoScanResult } from '../../shared/types'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

const { parseWslPathMock, toWindowsWslPathMock } = vi.hoisted(() => ({
  parseWslPathMock: vi.fn(() => null as { distro: string } | null),
  toWindowsWslPathMock: vi.fn(
    (linuxPath: string, distro: string) => `\\\\wsl$\\${distro}${linuxPath}`
  )
}))

vi.mock('../wsl', () => ({
  parseWslPath: parseWslPathMock,
  toWindowsWslPath: toWindowsWslPathMock
}))

import { detectUntrackedNestedRepos, NESTED_REPO_DISPLAY_CAP } from './nested-repo-warning'
import {
  createLocalNestedRepoScanFilesystem,
  scanNestedRepos
} from '../project-groups/nested-repo-discovery'

const TOPLEVEL = '/repo'

function scanResult(
  absolutePaths: string[],
  extra?: Partial<NestedRepoScanResult>
): NestedRepoScanResult {
  return {
    selectedPath: TOPLEVEL,
    selectedPathKind: 'non_git_folder',
    repos: absolutePaths.map((path, index) => ({
      path,
      displayName: path.split('/').pop() ?? path,
      depth: 1 + index * 0
    })),
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: 5000,
    ...extra
  }
}

function lsFilesZOutput(entries: { mode: string; path: string }[]): string {
  return entries
    .map((entry) => `${entry.mode} 0123456789abcdef0123456789abcdef01234567 0\t${entry.path}\0`)
    .join('')
}

/** rev-parse resolves the toplevel; ls-files / config get their own queued answers. */
function queueGit(args: {
  toplevel?: string | Error
  lsFiles?: string | Error
  gitmodules?: string | Error
}): void {
  gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
    if (argv[0] === 'rev-parse') {
      if (args.toplevel instanceof Error) {
        throw args.toplevel
      }
      return { stdout: `${args.toplevel ?? TOPLEVEL}\n`, stderr: '' }
    }
    if (argv[0] === 'ls-files') {
      if (args.lsFiles instanceof Error) {
        throw args.lsFiles
      }
      return { stdout: args.lsFiles ?? '', stderr: '' }
    }
    if (argv[0] === 'config') {
      if (args.gitmodules instanceof Error) {
        throw args.gitmodules
      }
      if (args.gitmodules === undefined) {
        throw new Error('exit 1: no .gitmodules')
      }
      return { stdout: args.gitmodules, stderr: '' }
    }
    throw new Error(`unexpected git argv: ${argv.join(' ')}`)
  })
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  parseWslPathMock.mockReset()
  parseWslPathMock.mockReturnValue(null)
  toWindowsWslPathMock.mockClear()
})

describe('detectUntrackedNestedRepos', () => {
  it('returns sorted nested repos with trailing slashes when none are submodules', async () => {
    queueGit({})
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/frontend`, `${TOPLEVEL}/backend`]))

    const result = await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    expect(result).toEqual({ paths: ['backend/', 'frontend/'], truncated: false, moreCount: 0 })
  })

  it('excludes staged gitlinks and returns null when only gitlinks remain', async () => {
    queueGit({ lsFiles: lsFilesZOutput([{ mode: '160000', path: 'sub' }]) })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/sub`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('keeps untracked nested repos while excluding gitlinks', async () => {
    queueGit({ lsFiles: lsFilesZOutput([{ mode: '160000', path: 'sub' }]) })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/sub`, `${TOPLEVEL}/frontend`]))

    const result = await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    expect(result).toEqual({ paths: ['frontend/'], truncated: false, moreCount: 0 })
  })

  it('passes canonical relative pathspecs to ls-files, never absolute paths', async () => {
    queueGit({})
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/frontend`, `${TOPLEVEL}/backend`]))

    await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    const lsFilesCall = gitExecFileAsyncMock.mock.calls.find((call) => call[0][0] === 'ls-files')
    expect(lsFilesCall?.[0]).toEqual(['ls-files', '-z', '--stage', '--', 'backend', 'frontend'])
  })

  it('issues exactly one ls-files and one gitmodules config call regardless of candidate count', async () => {
    queueGit({ gitmodules: '' })
    const scan = vi.fn(async () =>
      scanResult(
        Array.from({ length: 12 }, (_, i) => `${TOPLEVEL}/pkg-${String(i).padStart(2, '0')}`)
      )
    )

    await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    const argv0 = gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])
    expect(argv0.filter((name) => name === 'ls-files')).toHaveLength(1)
    expect(argv0.filter((name) => name === 'config')).toHaveLength(1)
    expect(argv0.filter((name) => name === 'rev-parse')).toHaveLength(1)
  })

  it('excludes submodules declared only in .gitmodules', async () => {
    queueGit({ gitmodules: 'submodule.sub2.path sub2\n' })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/sub2`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('normalizes .gitmodules path forms before comparing', async () => {
    queueGit({ gitmodules: 'submodule.a.path sub2/\nsubmodule.b.path nested\\win\n' })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/sub2`, `${TOPLEVEL}/nested/win`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('keeps candidates when .gitmodules is absent (config exits non-zero)', async () => {
    queueGit({ gitmodules: new Error('exit code 1') })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/frontend`]))

    const result = await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    expect(result).toEqual({ paths: ['frontend/'], truncated: false, moreCount: 0 })
  })

  it('returns null when the scan finds nothing', async () => {
    queueGit({})
    const scan = vi.fn(async () => scanResult([]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('caps the displayed paths and reports the real remainder', async () => {
    queueGit({})
    const scan = vi.fn(async () =>
      scanResult(
        Array.from({ length: 12 }, (_, i) => `${TOPLEVEL}/pkg-${String(i).padStart(2, '0')}`)
      )
    )

    const result = await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    expect(result?.paths).toHaveLength(NESTED_REPO_DISPLAY_CAP)
    expect(result?.truncated).toBe(true)
    expect(result?.moreCount).toBe(2)
  })

  it('reports a floor remainder when the scanner itself truncated', async () => {
    queueGit({})
    const scan = vi.fn(async () =>
      scanResult(
        Array.from({ length: 100 }, (_, i) => `${TOPLEVEL}/pkg-${String(i).padStart(3, '0')}`),
        { truncated: true }
      )
    )

    const result = await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    expect(result?.paths).toHaveLength(NESTED_REPO_DISPLAY_CAP)
    expect(result?.truncated).toBe(true)
    expect(result?.moreCount).toBe(90)
  })

  it('returns null when rev-parse fails', async () => {
    queueGit({ toplevel: new Error('not a git repo') })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/frontend`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('returns null when ls-files fails', async () => {
    queueGit({ lsFiles: new Error('boom') })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/frontend`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('returns null when the scan rejects', async () => {
    queueGit({})
    const scan = vi.fn(async () => {
      throw new Error('scan exploded')
    })

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('returns null when the scan timed out, even with partial results', async () => {
    queueGit({})
    const scan = vi.fn(async () =>
      scanResult([`${TOPLEVEL}/frontend`, `${TOPLEVEL}/backend`], { timedOut: true })
    )

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('canonicalizes Windows-style separators for pathspecs and display', async () => {
    const winToplevel = 'C:\\repo'
    queueGit({ toplevel: winToplevel })
    const scan = vi.fn(async () => scanResult(['C:\\repo\\packages\\api']))

    const result = await detectUntrackedNestedRepos(winToplevel, { scan })

    const lsFilesCall = gitExecFileAsyncMock.mock.calls.find((call) => call[0][0] === 'ls-files')
    expect(lsFilesCall?.[0]).toEqual(['ls-files', '-z', '--stage', '--', 'packages/api'])
    expect(result).toEqual({ paths: ['packages/api/'], truncated: false, moreCount: 0 })
  })

  it('translates WSL toplevels to UNC before scanning', async () => {
    parseWslPathMock.mockReturnValue({ distro: 'Ubuntu' })
    queueGit({ toplevel: '/home/u/repo' })
    const scan = vi.fn(async (_args: Parameters<typeof scanNestedRepos>[0]) => scanResult([]))

    await detectUntrackedNestedRepos('\\\\wsl$\\Ubuntu\\home\\u\\repo', { scan })

    expect(toWindowsWslPathMock).toHaveBeenCalledWith('/home/u/repo', 'Ubuntu')
    expect(scan.mock.calls[0]?.[0]?.path).toBe('\\\\wsl$\\Ubuntu/home/u/repo')
  })

  it('passes bounded options and a neutralized filesystem to the scanner', async () => {
    queueGit({})
    const scan = vi.fn(async (_args: Parameters<typeof scanNestedRepos>[0]) => scanResult([]))

    await detectUntrackedNestedRepos(TOPLEVEL, { scan })

    const args = scan.mock.calls[0]?.[0]
    expect(args?.options).toEqual({ maxDepth: 3, maxRepos: 100, timeoutMs: 5000 })
    expect(await args?.filesystem?.isSelectedPathGitRepo(TOPLEVEL)).toBe(false)
    expect(await args?.filesystem?.readTextFile?.('/repo/.gitignore')).toBe('')
  })

  it('drops candidates resolving outside the toplevel', async () => {
    queueGit({})
    const scan = vi.fn(async () => scanResult([TOPLEVEL, '/elsewhere/x']))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })

  it('parses -z records with spaces and tabs in paths', async () => {
    queueGit({
      lsFiles: lsFilesZOutput([{ mode: '160000', path: 'odd dir\twith tab' }])
    })
    const scan = vi.fn(async () => scanResult([`${TOPLEVEL}/odd dir\twith tab`]))

    expect(await detectUntrackedNestedRepos(TOPLEVEL, { scan })).toBeNull()
  })
})

describe('detectUntrackedNestedRepos (real scanner integration)', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-nested-repo-warning-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('finds a gitignored nested repo because the override defeats gitignore pruning', async () => {
    await writeFile(join(tempRoot, '.gitignore'), 'frontend/\n')
    await mkdir(join(tempRoot, 'frontend', '.git'), { recursive: true })
    queueGit({ toplevel: tempRoot })

    const result = await detectUntrackedNestedRepos(tempRoot)

    expect(result).toEqual({ paths: ['frontend/'], truncated: false, moreCount: 0 })
  })

  it('local filesystem factory reads a real directory with a .git marker', async () => {
    await mkdir(join(tempRoot, 'sub', '.git'), { recursive: true })

    const scan = await scanNestedRepos({
      path: tempRoot,
      filesystem: createLocalNestedRepoScanFilesystem()
    })

    expect(scan.repos.map((repo) => repo.path)).toEqual([join(tempRoot, 'sub')])
  })
})
