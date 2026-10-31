import type { ConversationPreferences } from '../../../src/shared/conversation-navigation-preferences'
import { sortProjectEntries } from '../../../src/shared/project-section-order'
import type { ProjectSectionCatalog } from '../worktree/workspace-list-sections'
import type { ConversationProject } from './project-conversations'

export function orderProjectConversations(
  projects: Iterable<ConversationProject>,
  args: {
    query?: string
    projectCatalog?: ProjectSectionCatalog
    preferences?: ConversationPreferences
    archived?: boolean
  }
): ConversationProject[] {
  const catalog = args.projectCatalog
  const query = args.query?.trim().toLocaleLowerCase()
  const entries = [...projects].map(
    (project) =>
      [
        project.key,
        {
          ...project,
          label: project.title,
          items: project.workspaces,
          repoIds: new Set(project.workspaces.map((workspace) => workspace.repoId))
        }
      ] as const
  )
  return sortProjectEntries(entries, catalog?.projectOrderBy ?? 'manual', catalog?.repoOrder)
    .map(([, project]) => project)
    .map((project) => ({
      ...project,
      data: project.data
        .filter(
          (row) =>
            (row.preferenceKey !== undefined &&
              args.preferences?.entries[row.preferenceKey]?.archived === true) ===
            (args.archived === true)
        )
        .sort(
          (a, b) =>
            Number(
              b.preferenceKey !== undefined &&
                args.preferences?.entries[b.preferenceKey]?.pinned === true
            ) -
              Number(
                a.preferenceKey !== undefined &&
                  args.preferences?.entries[a.preferenceKey]?.pinned === true
              ) || b.at - a.at
        )
        .filter(
          (row) =>
            !query ||
            `${project.title} ${row.title} ${row.agent ?? ''}`.toLocaleLowerCase().includes(query)
        )
    }))
    .filter(
      (project) =>
        !args.preferences?.hiddenProjects?.[project.visibilityKey ?? project.key] &&
        (!args.archived || project.data.length > 0) &&
        (!query || project.data.length > 0 || project.title.toLocaleLowerCase().includes(query))
    )
}
