import type { PublicKnownRuntimeEnvironment } from '../shared/runtime-environments'
import type {
  RuntimeRepoList,
  RuntimeRepoSearchRefs,
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult,
  RuntimeWorktreeRecord
} from '../shared/runtime-types'
import type { MemorySnapshot, WorktreeMemory } from '../shared/process-stats-types'

export function formatMemorySnapshot(snapshot: MemorySnapshot): string {
  const topWorktrees = [...snapshot.worktrees].sort((a, b) => b.memory - a.memory).slice(0, 10)
  const hostAvailable = snapshot.host.availableMemory ?? snapshot.host.freeMemory
  const hostAvailableSource = snapshot.host.availableMemorySource ?? 'free-memory'
  const lines = [
    `collectedAt: ${new Date(snapshot.collectedAt).toISOString()}`,
    `totalMemory: ${formatByteCount(snapshot.totalMemory)}`,
    `processMemoryMetric: ${formatProcessMemoryMetric(snapshot.processMemoryMetric)}`,
    ...formatCommitLines(snapshot),
    `totalCpu: ${formatCpu(snapshot.totalCpu)}`,
    [
      `hostUsed: ${formatByteCount(snapshot.host.usedMemory)}`,
      `/ ${formatByteCount(snapshot.host.totalMemory)}`,
      `(${snapshot.host.memoryUsagePercent.toFixed(1)}%)`
    ].join(' '),
    [`hostAvailable: ${formatByteCount(hostAvailable)}`, `(${hostAvailableSource})`].join(' '),
    [
      `app: ${formatByteCount(snapshot.app.memory)}`,
      `(main ${formatByteCount(snapshot.app.main.memory)},`,
      `renderer ${formatByteCount(snapshot.app.renderer.memory)},`,
      `other ${formatByteCount(snapshot.app.other.memory)})`
    ].join(' '),
    `worktrees: ${snapshot.worktrees.length}`
  ]

  if (topWorktrees.length === 0) {
    lines.push('topWorktrees: none')
    return lines.join('\n')
  }

  lines.push('', 'Top worktrees:')
  for (const worktree of topWorktrees) {
    lines.push(formatWorktreeMemoryLine(worktree))
  }
  if (snapshot.worktrees.length > topWorktrees.length) {
    lines.push(`... ${snapshot.worktrees.length - topWorktrees.length} more worktrees`)
  }
  return lines.join('\n')
}

function formatWorktreeMemoryLine(worktree: WorktreeMemory): string {
  return [
    `- ${worktree.worktreeName}`,
    `${formatByteCount(worktree.memory)}`,
    ...(worktree.privateMemory === undefined
      ? []
      : [`${formatByteCount(worktree.privateMemory)} committed`]),
    `${formatCpu(worktree.cpu)}`,
    `${worktree.sessions.length} session${worktree.sessions.length === 1 ? '' : 's'}`
  ].join('  ')
}

// Why omitted rather than zeroed: a host that predates the field, or cannot read
// commit at all, must not be printed as agents committing nothing.
function formatCommitLines(snapshot: MemorySnapshot): string[] {
  if (typeof snapshot.totalPrivateMemory !== 'number') {
    return []
  }
  return [
    `totalPrivateMemory: ${formatByteCount(snapshot.totalPrivateMemory)}`,
    `processCommitMetric: ${formatProcessCommitMetric(snapshot.processCommitMetric)}`
  ]
}

function formatProcessCommitMetric(metric: MemorySnapshot['processCommitMetric']): string {
  return metric === 'private-bytes'
    ? 'summed private bytes; committed memory, counted whether resident or paged out'
    : `summed ${metric ?? 'unknown'}`
}

function formatCpu(cpu: number): string {
  return `${cpu.toFixed(1)}%`
}

function formatProcessMemoryMetric(metric: MemorySnapshot['processMemoryMetric']): string {
  return metric === 'working-set'
    ? 'summed working set; shared pages may repeat'
    : 'summed RSS; shared or aliased pages may repeat'
}

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)
  return `${formatted} ${units[unitIndex]}`
}

export function formatEnvironmentList(result: {
  environments: PublicKnownRuntimeEnvironment[]
}): string {
  if (result.environments.length === 0) {
    return 'No saved environments.'
  }
  return result.environments
    .map(
      (environment) =>
        `${environment.id}  ${environment.name}  ${environment.endpoints[0]?.endpoint ?? 'no-endpoint'}`
    )
    .join('\n')
}

export function formatEnvironment(environment: PublicKnownRuntimeEnvironment): string {
  return [
    `id: ${environment.id}`,
    `name: ${environment.name}`,
    `runtimeId: ${environment.runtimeId ?? 'unknown'}`,
    `lastUsedAt: ${environment.lastUsedAt ?? 'never'}`,
    `preferredEndpointId: ${environment.preferredEndpointId}`,
    ...environment.endpoints.map(
      (endpoint) => `endpoint: ${endpoint.id} ${endpoint.kind} ${endpoint.endpoint}`
    )
  ].join('\n')
}

export function formatWorktreePs(result: RuntimeWorktreePsResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${worktree.repo} ${worktree.branch}  live:${worktree.liveTerminalCount}  pty:${worktree.hasAttachedPty ? 'yes' : 'no'}  unread:${worktree.unread ? 'yes' : 'no'}\n${worktree.path}${worktree.preview ? `\npreview: ${worktree.preview}` : ''}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

export function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  return result.repos.map((repo) => `${repo.id}  ${repo.displayName}  ${repo.path}`).join('\n')
}

export function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

export function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  return result.truncated ? `${result.refs.join('\n')}\n\ntruncated: yes` : result.refs.join('\n')
}

export function formatWorktreeList(result: RuntimeWorktreeListResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map((worktree) => {
      const childCount = worktree.childWorktreeIds?.length ?? 0
      return `${String(worktree.id)}  ${String(worktree.branch)}  ${String(worktree.path)}\ndisplayName: ${String(worktree.displayName ?? '')}\nparentWorktreeId: ${String(worktree.parentWorktreeId ?? 'null')}\nchildWorktreeIds: ${childCount > 0 ? worktree.childWorktreeIds.join(',') : '[]'}\nlinkedIssue: ${String(worktree.linkedIssue ?? 'null')}\ncomment: ${String(worktree.comment ?? '')}`
    })
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

export function formatWorktreeShow(result: { worktree: RuntimeWorktreeRecord }): string {
  const worktree = result.worktree
  return Object.entries(worktree)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}
