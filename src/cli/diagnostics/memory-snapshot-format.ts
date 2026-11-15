import type { MemorySnapshot, WorktreeMemory } from '../../shared/process-stats-types'

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

// Missing commit fields mean unknown usage, not zero.
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
  if (metric === 'footprint') {
    return 'summed memory footprint (Activity Monitor); includes graphics memory'
  }
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
