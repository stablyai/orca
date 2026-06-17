import type { Repo, Worktree, WorkspaceStatus } from '../../src/shared/types'
import { cloneDefaultWorkspaceStatuses } from '../../src/shared/workspace-statuses'
import {
  addHostSectionRows,
  type HostSectionOption
} from '../../src/renderer/src/components/sidebar/host-section-rows'
import {
  buildRows,
  type WorktreeGroupBy
} from '../../src/renderer/src/components/sidebar/worktree-list-groups'
import { ALL_EXECUTION_HOSTS_SCOPE, LOCAL_EXECUTION_HOST_ID } from '../../src/shared/execution-host'
import { measure, type TimingStats } from './non-terminal-benchmark-stats'

const SIDEBAR_ITERATIONS = 100

type SidebarScenario = {
  scenario: string
  groupBy: WorktreeGroupBy
  repoCount: number
  worktreesPerRepo: number
  hostCount?: number
  hostSections?: boolean
}

export type SidebarResult = {
  scenario: string
  worktrees: number
  rows: number
  stats: TimingStats
}

function makeRepos(repoCount: number, hostCount: number): Repo[] {
  return Array.from({ length: repoCount }, (_, index) => {
    const hostIndex = index % hostCount
    return {
      id: `repo-${index}`,
      path: `/tmp/orca-perf/repo-${index}`,
      displayName: `Repo ${index}`,
      badgeColor: 'blue',
      addedAt: 1_700_000_000_000 + index,
      executionHostId:
        hostIndex === 0 ? undefined : (`runtime:bench-host-${hostIndex}` as Repo['executionHostId'])
    } as Repo
  })
}

function makeWorktrees(repos: readonly Repo[], worktreesPerRepo: number): Worktree[] {
  const statuses: WorkspaceStatus[] = ['in-progress', 'in-review', 'done', 'closed']
  const result: Worktree[] = []
  for (const repo of repos) {
    for (let index = 0; index < worktreesPerRepo; index += 1) {
      const id = `${repo.id}::/tmp/orca-perf/${repo.id}/wt-${index}`
      result.push({
        id,
        instanceId: `instance-${id}`,
        repoId: repo.id,
        path: `/tmp/orca-perf/${repo.id}/wt-${index}`,
        head: `head-${index}`,
        branch: index === 0 ? 'main' : `feature/${index}`,
        isBare: false,
        isMainWorktree: index === 0,
        isSparse: false,
        displayName: index === 0 ? 'main' : `feature-${index}`,
        isArchived: false,
        isUnread: index % 11 === 0,
        isPinned: index % 23 === 0,
        sortOrder: index,
        manualOrder: index,
        lastActivityAt:
          1_700_000_000_000 + (repos.length - Number(repo.id.slice(5))) * 10_000 + index,
        workspaceStatus: statuses[index % statuses.length],
        createdWithAgent: index % 7 === 0,
        pendingFirstAgentMessageRename: false,
        firstAgentMessageRenameError: null,
        baseRef: 'main'
      } as Worktree)
    }
  }
  return result
}

function makeHostOptions(hostCount: number): HostSectionOption[] {
  return Array.from({ length: hostCount }, (_, index) =>
    index === 0
      ? {
          id: LOCAL_EXECUTION_HOST_ID,
          kind: 'local',
          label: 'This computer',
          detail: 'Local',
          health: 'local'
        }
      : {
          id: `runtime:bench-host-${index}` as HostSectionOption['id'],
          kind: 'runtime',
          label: `Bench host ${index}`,
          detail: 'Runtime',
          health: 'available'
        }
  )
}

function buildSidebarRows(args: SidebarScenario): { rowCount: number } {
  const hostCount = args.hostCount ?? 1
  const repos = makeRepos(args.repoCount, hostCount)
  const worktrees = makeWorktrees(repos, args.worktreesPerRepo)
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const repoOrder = new Map(repos.map((repo, index) => [repo.id, index]))
  const rows = buildRows(
    args.groupBy,
    worktrees,
    repoMap,
    null,
    new Set(),
    repoOrder,
    cloneDefaultWorkspaceStatuses(),
    'manual'
  )
  if (!args.hostSections) {
    return { rowCount: rows.length }
  }
  return {
    rowCount: addHostSectionRows({
      rows,
      hostOptions: makeHostOptions(hostCount),
      workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
      visibleWorkspaceHostIds: makeHostOptions(hostCount).map((host) => host.id),
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      preferProjectGrouping: true
    }).length
  }
}

export function runSidebarRowProjectionBenchmark(): SidebarResult[] {
  const sidebarScenarios: SidebarScenario[] = [
    {
      scenario: 'repo grouping, 10 repos × 100 worktrees',
      groupBy: 'repo',
      repoCount: 10,
      worktreesPerRepo: 100
    },
    {
      scenario: 'status grouping, 10 repos × 100 worktrees',
      groupBy: 'workspace-status',
      repoCount: 10,
      worktreesPerRepo: 100
    },
    {
      scenario: 'PR grouping, 10 repos × 100 worktrees',
      groupBy: 'pr-status',
      repoCount: 10,
      worktreesPerRepo: 100
    },
    {
      scenario: 'host sections, 10 repos × 100 worktrees × 3 hosts',
      groupBy: 'repo',
      repoCount: 10,
      worktreesPerRepo: 100,
      hostCount: 3,
      hostSections: true
    }
  ]
  return sidebarScenarios.map((scenario) => {
    let rowCount = 0
    const result = measure(SIDEBAR_ITERATIONS, () => {
      rowCount = buildSidebarRows(scenario).rowCount
    })
    return {
      scenario: scenario.scenario,
      worktrees: scenario.repoCount * scenario.worktreesPerRepo,
      rows: rowCount,
      stats: result
    }
  })
}
