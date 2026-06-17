import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { listWorktrees } from '../../src/main/git/worktree'
import { round, stats, type TimingStats } from './non-terminal-benchmark-stats'

const execFileAsync = promisify(execFile)
const GIT_WARMUP_ITERATIONS = 2
const GIT_ITERATIONS = 20

export type GitCountReader = () => Promise<number>

export type GitResult = {
  scenario: string
  repos: number
  worktreesPerRepo: number
  returnedWorktrees: number
  gitProcessesPerIteration: number
  wallStats: TimingStats
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

export async function createGitRepoWithWorktrees(
  worktreeCount: number
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-non-terminal-git-bench-'))
  const repo = path.join(root, 'repo')
  await execFileAsync('git', ['init', '-q', repo])
  await git(['config', 'user.email', 'bench@example.com'], repo)
  await git(['config', 'user.name', 'Bench'], repo)
  await writeFile(path.join(repo, 'README.md'), 'bench\n')
  await git(['add', 'README.md'], repo)
  await git(['commit', '-q', '-m', 'initial'], repo)
  for (let index = 0; index < worktreeCount; index += 1) {
    await git(['worktree', 'add', '--detach', '-q', path.join(root, `wt-${index}`), 'HEAD'], repo)
  }
  return { root, repo }
}

async function resolveRealGitPath(): Promise<string> {
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('xcrun', ['-f', 'git'])
    return stdout.trim()
  }
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const { stdout } = await execFileAsync(command, ['git'])
  return (
    stdout
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? 'git'
  )
}

async function createGitCountShim(): Promise<{
  shimDir: string
  countFile: string
}> {
  const shimDir = await mkdtemp(path.join(tmpdir(), 'orca-git-count-shim-'))
  const countFile = path.join(shimDir, 'count.txt')
  await writeFile(countFile, '')
  if (process.platform === 'win32') {
    await writeFile(
      path.join(shimDir, 'git.cmd'),
      `@echo off\r\necho 1>> "%ORCA_GIT_COUNT_FILE%"\r\n"%ORCA_REAL_GIT%" %*\r\n`
    )
  } else {
    const shimPath = path.join(shimDir, 'git')
    await writeFile(
      shimPath,
      `#!/bin/sh\nprintf '1\\n' >> "$ORCA_GIT_COUNT_FILE"\nexec "$ORCA_REAL_GIT" "$@"\n`
    )
    await chmod(shimPath, 0o755)
  }
  return { shimDir, countFile }
}

async function readGitProcessCount(countFile: string): Promise<number> {
  const countText = await readFile(countFile, 'utf8').catch(() => '')
  return countText.split('\n').filter(Boolean).length
}

export async function withGitCountShim<T>(
  fn: (readCount: GitCountReader) => Promise<T>
): Promise<T> {
  const realGitPath = await resolveRealGitPath()
  const shim = await createGitCountShim()
  const previousPath = process.env.PATH
  const previousRealGit = process.env.ORCA_REAL_GIT
  const previousCountFile = process.env.ORCA_GIT_COUNT_FILE
  process.env.PATH = `${shim.shimDir}${path.delimiter}${previousPath ?? ''}`
  process.env.ORCA_REAL_GIT = realGitPath
  process.env.ORCA_GIT_COUNT_FILE = shim.countFile
  try {
    // Why: keep shim setup outside timed regions so wall-time samples only
    // include Orca's worktree refresh path plus the counted git subprocess.
    return await fn(() => readGitProcessCount(shim.countFile))
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previousPath
    }
    if (previousRealGit === undefined) {
      delete process.env.ORCA_REAL_GIT
    } else {
      process.env.ORCA_REAL_GIT = previousRealGit
    }
    if (previousCountFile === undefined) {
      delete process.env.ORCA_GIT_COUNT_FILE
    } else {
      process.env.ORCA_GIT_COUNT_FILE = previousCountFile
    }
    await rm(shim.shimDir, { recursive: true, force: true })
  }
}

async function measureListWorktrees(
  repo: string,
  readGitCount: GitCountReader
): Promise<{
  wallMs: number
  gitProcesses: number
  returnedWorktrees: number
}> {
  const processCountBefore = await readGitCount()
  const startedAt = performance.now()
  const worktrees = await listWorktrees(repo)
  const wallMs = round(performance.now() - startedAt)
  const processCountAfter = await readGitCount()
  return {
    wallMs,
    gitProcesses: processCountAfter - processCountBefore,
    returnedWorktrees: worktrees.length
  }
}

async function measureListWorktreesRepeated(repo: string): Promise<{
  wallStats: TimingStats
  gitProcessesPerIteration: number
  returnedWorktrees: number
}> {
  return withGitCountShim(async (readGitCount) => {
    const wallSamples: number[] = []
    const processCounts: number[] = []
    let returnedWorktrees = 0
    for (let index = 0; index < GIT_WARMUP_ITERATIONS; index += 1) {
      await measureListWorktrees(repo, readGitCount)
    }
    for (let index = 0; index < GIT_ITERATIONS; index += 1) {
      const measured = await measureListWorktrees(repo, readGitCount)
      wallSamples.push(measured.wallMs)
      processCounts.push(measured.gitProcesses)
      returnedWorktrees = measured.returnedWorktrees
    }
    return {
      wallStats: stats(wallSamples),
      gitProcessesPerIteration: Math.max(...processCounts),
      returnedWorktrees
    }
  })
}

async function measureConcurrentRepoRefresh(fixtures: { repo: string }[]): Promise<GitResult> {
  return withGitCountShim(async (readGitCount) => {
    const wallSamples: number[] = []
    let gitProcessesPerIteration = 0
    let returnedWorktrees = 0
    for (let index = 0; index < GIT_WARMUP_ITERATIONS; index += 1) {
      await Promise.all(fixtures.map((fixture) => listWorktrees(fixture.repo)))
    }
    for (let iteration = 0; iteration < GIT_ITERATIONS; iteration += 1) {
      const processCountBefore = await readGitCount()
      const startedAt = performance.now()
      const worktreeLists = await Promise.all(
        fixtures.map((fixture) => listWorktrees(fixture.repo))
      )
      wallSamples.push(performance.now() - startedAt)
      const processCountAfter = await readGitCount()
      gitProcessesPerIteration = Math.max(
        gitProcessesPerIteration,
        processCountAfter - processCountBefore
      )
      returnedWorktrees = worktreeLists.reduce((total, worktrees) => total + worktrees.length, 0)
    }
    return {
      scenario: 'concurrent all-repo refresh',
      repos: fixtures.length,
      worktreesPerRepo: 10,
      returnedWorktrees,
      gitProcessesPerIteration,
      wallStats: stats(wallSamples)
    }
  })
}

export async function runGitWorktreeRefreshBenchmark(): Promise<GitResult[]> {
  const gitResults: GitResult[] = []
  for (const worktreeCount of [10, 30, 60]) {
    const fixture = await createGitRepoWithWorktrees(worktreeCount)
    try {
      const measured = await measureListWorktreesRepeated(fixture.repo)
      gitResults.push({
        scenario: `single repo refresh`,
        repos: 1,
        worktreesPerRepo: worktreeCount,
        returnedWorktrees: measured.returnedWorktrees,
        gitProcessesPerIteration: measured.gitProcessesPerIteration,
        wallStats: measured.wallStats
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }

  const multiRepoFixtures = await Promise.all(
    Array.from({ length: 5 }, () => createGitRepoWithWorktrees(10))
  )
  try {
    gitResults.push(await measureConcurrentRepoRefresh(multiRepoFixtures))
  } finally {
    await Promise.all(
      multiRepoFixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true }))
    )
  }
  return gitResults
}
