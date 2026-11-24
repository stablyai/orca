import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import {
  agentStatusGroup,
  byStatusThenRecent,
  everyRow,
  hostAgents,
  type AgentListInput,
  type AgentListRow,
  type AgentStatusGroup
} from '../agents/agent-list-rows'

export const projectStages = [
  'needs-you',
  'working',
  'done',
  'idle',
  'interrupted',
  'last-seen'
] as const
export type ProjectStage = AgentStatusGroup | 'interrupted' | 'last-seen'

export type CommanderProject = {
  key: string
  hostId: string
  executionHostId: string
  name: string
  rows: AgentListRow[]
  live: boolean
  counts: Record<ProjectStage, number>
}

export function rowStage(row: AgentListRow): ProjectStage {
  if (row.stale || row.dotState === 'unverifiable') {
    return 'last-seen'
  }
  return row.dotState === 'interrupted' ? 'interrupted' : agentStatusGroup(row.dotState)
}

type CatalogProject = { hostId: string; repoId: string; name: string; executionHostId: string }

export function commanderProjects(
  input: AgentListInput,
  catalog: readonly CatalogProject[] = []
): CommanderProject[] {
  const result: CommanderProject[] = []
  for (const { id } of input.hosts) {
    const projects = new Map<string, CommanderProject>()
    const host = hostAgents(input, id)
    const projectFor = (
      repoId: string,
      name: string,
      executionHostId = 'local'
    ): CommanderProject => {
      const key = JSON.stringify([id, executionHostId, repoId])
      let project = projects.get(key)
      if (!project) {
        project = {
          key,
          hostId: id,
          executionHostId,
          name: name || repoId,
          live: host.live && executionHostId === 'local',
          rows: [],
          counts: { 'needs-you': 0, working: 0, done: 0, idle: 0, interrupted: 0, 'last-seen': 0 }
        }
        projects.set(key, project)
      }
      return project
    }
    for (const repo of catalog) {
      if (repo.hostId === id) {
        projectFor(repo.repoId, repo.name, repo.executionHostId)
      }
    }
    for (const worktree of input.worktreeInfo[id]?.projects ?? []) {
      projectFor(
        getRepoIdFromWorktreeId(worktree.worktreeId),
        worktree.repo,
        worktree.hostId
      ).live = host.live
    }
    for (const row of everyRow(host.roots)) {
      const project = projectFor(
        getRepoIdFromWorktreeId(row.entry.worktreeId),
        row.entry.repo,
        row.entry.hostId
      )
      project.live = host.live
      project.rows.push(row)
      project.counts[rowStage(row)]++
    }
    for (const project of projects.values()) {
      project.rows.sort(byStatusThenRecent)
      result.push(project)
    }
  }
  return result.sort(
    (a, b) =>
      b.counts['needs-you'] - a.counts['needs-you'] ||
      b.counts.working - a.counts.working ||
      Number(b.live) - Number(a.live) ||
      a.name.localeCompare(b.name)
  )
}
