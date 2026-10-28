import type { Section } from '../worktree/workspace-list-types'

/** Moves the system Workspaces sections to the top of their host block and drops empty ones. A collapsed section has no rows but keeps its count, so it stays expandable. */
export function hoistMultiRepoWorkspaceSections(
  sections: readonly Section[],
  workspaceSectionKeys: ReadonlySet<string>,
  hostHeaderKeys: ReadonlySet<string>
): Section[] {
  if (workspaceSectionKeys.size === 0) {
    return [...sections]
  }
  const result: Section[] = []
  let blockStart = 0
  let hoisted = 0
  for (const section of sections) {
    if (hostHeaderKeys.has(section.key)) {
      result.push(section)
      blockStart = result.length
      hoisted = 0
      continue
    }
    if (!workspaceSectionKeys.has(section.key)) {
      result.push(section)
      continue
    }
    if (section.data.length === 0 && !section.pendingCreations?.length && !section.count) {
      continue
    }
    result.splice(blockStart + hoisted, 0, section)
    hoisted += 1
  }
  return result
}
