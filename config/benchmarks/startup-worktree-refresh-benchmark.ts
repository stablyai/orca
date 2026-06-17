import { rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { listWorktrees } from '../../src/main/git/worktree'
import { stats, type TimingStats } from './non-terminal-benchmark-stats'
import {
  createGitRepoWithWorktrees,
  withGitCountShim,
  type GitCountReader
} from './git-worktree-refresh-benchmark'

const STARTUP_REFRESH_ITERATIONS = 10
const STARTUP_REFRESH_WARMUP_ITERATIONS = 2

export type StartupWorktreeRefreshResult = {
  scenario: string
  repos: number
  worktreesPerRepo: number
  refreshWaves: number
  returnedWorktrees: number
  gitProcessesPerIteration: number
  stats: TimingStats
}

type RepoFixture = Awaited<ReturnType<typeof createGitRepoWithWorktrees>>

async function createRepoFixtures(
  repoCount: number,
  worktreesPerRepo: number
): Promise<RepoFixture[]> {
  return Promise.all(
    Array.from({ length: repoCount }, () => createGitRepoWithWorktrees(worktreesPerRepo))
  )
}

async function listAllRepos(fixtures: RepoFixture[]): Promise<number> {
  const lists = await Promise.all(fixtures.map((fixture) => listWorktrees(fixture.repo)))
  return lists.reduce((total, list) => total + list.length, 0)
}

async function measureStartupShape(args: {
  fixtures: RepoFixture[]
  refreshWaves: number
  readGitCount: GitCountReader
}): Promise<{
  wallMs: number
  gitProcesses: number
  returnedWorktrees: number
}> {
  const before = await args.readGitCount()
  const startedAt = performance.now()
  let returnedWorktrees = 0
  for (let wave = 0; wave < args.refreshWaves; wave += 1) {
    returnedWorktrees += await listAllRepos(args.fixtures)
  }
  const after = await args.readGitCount()
  return {
    wallMs: performance.now() - startedAt,
    gitProcesses: after - before,
    returnedWorktrees
  }
}

async function measureRepeated(args: {
  fixtures: RepoFixture[]
  repoCount: number
  worktreesPerRepo: number
  refreshWaves: number
  scenario: string
}): Promise<StartupWorktreeRefreshResult> {
  return withGitCountShim(async (readGitCount) => {
    const wallSamples: number[] = []
    const gitProcessSamples: number[] = []
    let returnedWorktrees = 0
    for (let index = 0; index < STARTUP_REFRESH_WARMUP_ITERATIONS; index += 1) {
      await measureStartupShape({
        fixtures: args.fixtures,
        refreshWaves: args.refreshWaves,
        readGitCount
      })
    }
    for (let iteration = 0; iteration < STARTUP_REFRESH_ITERATIONS; iteration += 1) {
      const measured = await measureStartupShape({
        fixtures: args.fixtures,
        refreshWaves: args.refreshWaves,
        readGitCount
      })
      wallSamples.push(measured.wallMs)
      gitProcessSamples.push(measured.gitProcesses)
      returnedWorktrees = measured.returnedWorktrees
    }
    return {
      scenario: args.scenario,
      repos: args.repoCount,
      worktreesPerRepo: args.worktreesPerRepo,
      refreshWaves: args.refreshWaves,
      returnedWorktrees,
      gitProcessesPerIteration: Math.max(...gitProcessSamples),
      stats: stats(wallSamples)
    }
  })
}

export async function runStartupWorktreeRefreshBenchmark(): Promise<
  StartupWorktreeRefreshResult[]
> {
  const scenarios = [
    { repoCount: 10, worktreesPerRepo: 5 },
    { repoCount: 20, worktreesPerRepo: 5 }
  ]
  const results: StartupWorktreeRefreshResult[] = []
  for (const scenario of scenarios) {
    const fixtures = await createRepoFixtures(scenario.repoCount, scenario.worktreesPerRepo)
    try {
      results.push(
        await measureRepeated({
          fixtures,
          ...scenario,
          refreshWaves: 1,
          scenario: 'single all-repo startup refresh wave'
        })
      )
      results.push(
        await measureRepeated({
          fixtures,
          ...scenario,
          refreshWaves: 2,
          scenario: 'startup-shaped duplicate all-repo refresh waves'
        })
      )
    } finally {
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true }))
      )
    }
  }
  return results
}
