import type { Section } from './workspace-list-types'

export function collapseWorkspaceListSections(
  sections: readonly Section[],
  collapsedGroups: ReadonlySet<string>
): Section[] {
  const visible: Section[] = []
  let hideDeeperThan: number | null = null
  for (const section of sections) {
    if (hideDeeperThan !== null && section.depth > hideDeeperThan) {
      continue
    }
    hideDeeperThan = null
    visible.push({
      ...section,
      data: collapsedGroups.has(section.key) ? [] : section.data
    })
    if (collapsedGroups.has(section.key)) {
      hideDeeperThan = section.depth
    }
  }
  return visible
}
