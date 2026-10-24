import type {
  WorkspacePort,
  WorkspacePortHostScanResult,
  WorkspacePortOwner
} from '../shared/workspace-ports'

function ownerName(owner: WorkspacePortOwner): string {
  return owner.displayName || owner.worktreeId
}

// Why: two workspaces can share a display name; only their ids tell the rows apart.
function findAmbiguousOwnerNames(ports: readonly WorkspacePort[]): Set<string> {
  const idsByName = new Map<string, Set<string>>()
  for (const port of ports) {
    if (port.kind === 'workspace') {
      const name = ownerName(port.owner)
      idsByName.set(name, (idsByName.get(name) ?? new Set()).add(port.owner.worktreeId))
    }
  }
  return new Set([...idsByName].filter(([, ids]) => ids.size > 1).map(([name]) => name))
}

function formatPortOwner(port: WorkspacePort, ambiguousNames: ReadonlySet<string>): string {
  if (port.kind === 'workspace') {
    const name = ownerName(port.owner)
    return ambiguousNames.has(name)
      ? `workspace=${name} (${port.owner.worktreeId})`
      : `workspace=${name}`
  }
  return port.kind === 'container' ? 'workspace=(container)' : 'workspace=(none)'
}

function formatPortRow(port: WorkspacePort, ambiguousNames: ReadonlySet<string> | null): string {
  return [
    String(port.port),
    ...(ambiguousNames ? [formatPortOwner(port, ambiguousNames)] : []),
    `pid=${port.pid ?? '?'}`,
    port.processName ?? '(unknown process)',
    port.connectHost,
    port.protocol,
    ...(port.kind === 'workspace' ? [`match=${port.owner.confidence}`] : []),
    ...(port.kind === 'workspace' && port.advertisedUrl ? [`url=${port.advertisedUrl}`] : [])
  ].join('  ')
}

export function formatPortsScan(
  scan: WorkspacePortHostScanResult,
  options: { showOwner: boolean }
): string {
  const host = `host=${scan.executionHostId}`
  if (scan.unavailableReason) {
    return `Port scan unavailable: ${scan.unavailableReason}\n${host}`
  }
  if (scan.ports.length === 0) {
    return `No listening ports found.\n${host}`
  }
  const ambiguousNames = options.showOwner ? findAmbiguousOwnerNames(scan.ports) : null
  const rows = scan.ports.map((port) => formatPortRow(port, ambiguousNames))
  return `${rows.join('\n')}\n\n${host}`
}
