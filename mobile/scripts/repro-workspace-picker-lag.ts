#!/usr/bin/env npx tsx
import { performance } from 'node:perf_hooks'
import { createMockRepos, createMockWorktrees, readScenarioNumber } from './mobile-lag-scenario'
import { areWorktreeListsEqual } from '../src/worktree/worktree-list-snapshot'
import {
  buildSections,
  type FilterState,
  type Worktree
} from '../src/worktree/workspace-list-sections'

const repoCount = readScenarioNumber('MOCK_REPO_COUNT', 200)
const worktreeCount = readScenarioNumber('MOCK_WORKTREE_COUNT', 5000)
const pollCount = readScenarioNumber('MOCK_POLL_COUNT', 5)
const now = 1_781_725_740_000
const repos = createMockRepos(repoCount)
const baseWorktrees = createMockWorktrees(repos, worktreeCount, now) as Worktree[]
const filters: FilterState = {
  filterRepoIds: new Set(),
  hideSleeping: false,
  hideDefaultBranch: false
}
const pinnedIds = new Set<string>()

function freshSnapshot(): Worktree[] {
  return createMockWorktrees(repos, worktreeCount, now) as Worktree[]
}

function measure(label: string, fn: () => void): number {
  const start = performance.now()
  fn()
  const elapsed = performance.now() - start
  console.log(`${label}: ${elapsed.toFixed(2)}ms`)
  return elapsed
}

async function measureTapDelay(label: string, work: () => void): Promise<number> {
  const start = performance.now()
  const fired = new Promise<number>((resolve) => {
    setTimeout(() => resolve(performance.now()), 0)
  })
  work()
  const elapsed = (await fired) - start
  console.log(`${label}: ${elapsed.toFixed(2)}ms event-loop delay`)
  return elapsed
}

function rebuildSections(worktrees: readonly Worktree[]): void {
  buildSections(worktrees as Worktree[], 'recent', filters, '', 'repo', pinnedIds)
}

async function main(): Promise<void> {
  console.log(
    `workspace picker lag repro: ${repoCount} repos, ${worktreeCount} worktrees, ${pollCount} no-op polls`
  )

  measure('single buildSections', () => rebuildSections(baseWorktrees))
  measure('single areWorktreeListsEqual', () => {
    areWorktreeListsEqual(baseWorktrees, freshSnapshot())
  })

  await measureTapDelay('before: unconditional no-op poll rebuilds', () => {
    for (let i = 0; i < pollCount; i += 1) {
      rebuildSections(freshSnapshot())
    }
  })

  await measureTapDelay('after: equality-gated no-op polls', () => {
    let current = baseWorktrees
    for (let i = 0; i < pollCount; i += 1) {
      const next = freshSnapshot()
      if (!areWorktreeListsEqual(current, next)) {
        current = next
        rebuildSections(next)
      }
    }
  })
}

void main()
