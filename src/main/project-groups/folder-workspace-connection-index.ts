import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { FolderWorkspacePathConnectionResolution } from './folder-workspace-path-status'

type Connections = { count: number; local: boolean; first?: string; multiple: boolean }
type PathNode = { connections: Connections; children: Map<string, PathNode> }
const empty = (): Connections => ({ count: 0, local: false, multiple: false })
function merge(into: Connections, from: Connections): void {
  into.count += from.count
  into.local ||= from.local
  into.multiple ||= from.multiple || Boolean(into.first && from.first && into.first !== from.first)
  into.first ??= from.first
}
function pathParts(path: string): string[] {
  const parts = normalizeRuntimePathForComparison(path).split('/')
  if (parts.at(-1) === '') {
    parts.pop()
  }
  return parts
}

/** Descendant repo ownership determines group connections; paths are only a fallback for empty groups. */
export function createFolderWorkspaceConnectionResolver(
  groups: readonly ProjectGroup[],
  repos: readonly Repo[]
): (workspace: FolderWorkspace) => FolderWorkspacePathConnectionResolution {
  const own = new Map<string, Connections>()
  const children = new Map<string, string[]>()
  const paths: PathNode = { connections: empty(), children: new Map() }
  for (const group of groups) {
    if (!group.parentGroupId) {
      continue
    }
    const siblings = children.get(group.parentGroupId) ?? []
    siblings.push(group.id)
    children.set(group.parentGroupId, siblings)
  }
  for (const repo of repos) {
    const connectionId = getRepoRoutingConnectionId(repo)
    const summary: Connections = {
      count: 1,
      local: !connectionId,
      first: connectionId ?? undefined,
      multiple: false
    }
    if (repo.projectGroupId) {
      const group = own.get(repo.projectGroupId) ?? empty()
      merge(group, summary)
      own.set(repo.projectGroupId, group)
    }
    let node = paths
    for (const part of pathParts(repo.path)) {
      let child = node.children.get(part)
      if (!child) {
        child = { connections: empty(), children: new Map() }
        node.children.set(part, child)
      }
      merge(child.connections, summary)
      node = child
    }
  }
  const aggregated = new Map<string, Connections>()
  const visiting = new Set<string>()
  const collect = (id: string): Connections => {
    const previous = aggregated.get(id)
    if (previous) {
      return previous
    }
    if (visiting.has(id)) {
      return empty()
    }
    visiting.add(id)
    const result = { ...(own.get(id) ?? empty()) }
    for (const child of children.get(id) ?? []) {
      merge(result, collect(child))
    }
    visiting.delete(id)
    aggregated.set(id, result)
    return result
  }
  for (const group of groups) {
    collect(group.id)
  }
  return (workspace) => {
    let summary = aggregated.get(workspace.projectGroupId) ?? empty()
    if (summary.count === 0 && !workspace.connectionId) {
      let node: PathNode | undefined = paths
      for (const part of pathParts(workspace.folderPath)) {
        node = node?.children.get(part)
      }
      summary = node?.connections ?? empty()
    }
    if (workspace.connectionId) {
      return summary.local ||
        summary.multiple ||
        (summary.first && summary.first !== workspace.connectionId)
        ? { kind: 'ambiguous' }
        : { kind: 'ssh', connectionId: workspace.connectionId }
    }
    if (summary.multiple || (summary.local && summary.first)) {
      return { kind: 'ambiguous' }
    }
    return summary.first ? { kind: 'ssh', connectionId: summary.first } : { kind: 'local' }
  }
}
