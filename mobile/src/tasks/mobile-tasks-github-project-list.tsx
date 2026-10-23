import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import { View, FlatList, spacing, AlertTriangle, Inbox, Layers } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectGroupMeta,
  formatUpdatedAt,
  getRepoBadgeColor,
  projectFieldDisplayLabel,
  projectRowStatusLabel
} from './mobile-tasks-legacy-foundation'
import { MobileTaskRow, type TaskRowBadge } from './mobile-tasks-task-row'
import { projectRowStatusGlyph } from './mobile-tasks-status-glyph'
import { renderMobileTasksChrome } from './mobile-tasks-screen-chrome'
import { renderMobileTasksStatePage } from './mobile-tasks-list-surface'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'

// Field values on a row; the rest are in the item's sheet.
const MAX_FIELD_BADGES = 2

export function renderMobileTasksGitHubProjectList(model: PageChromeModel) {
  const {
    activeGitHubProject,
    findProjectRowRepo,
    githubProjectError,
    githubProjectListEntries,
    githubProjectLoading,
    githubProjectRepoSlugReady,
    githubProjectSummaryFields,
    githubProjectTable,
    insets,
    onPageScroll,
    refreshGitHubProject,
    setCollapsedGitHubProjectGroups,
    setProjectRowItem,
    setShowGitHubProjectPicker,
    taskUiReady,
    visibleGitHubProjectRows
  } = model
  if (githubProjectLoading && !githubProjectTable) {
    return renderMobileTasksStatePage(model, <StateView loading title="Loading project…" />)
  }
  if (!activeGitHubProject) {
    return renderMobileTasksStatePage(
      model,
      <StateView
        icon={Layers}
        title="Choose a GitHub project"
        message="Pick a project to see its items here."
        primary={
          taskUiReady
            ? {
                label: 'Browse projects',
                onPress: () => setShowGitHubProjectPicker(true)
              }
            : undefined
        }
      />
    )
  }
  if (githubProjectError && !githubProjectLoading) {
    return renderMobileTasksStatePage(
      model,
      <StateView
        icon={AlertTriangle}
        title="Couldn't load this project"
        message={githubProjectError}
        primary={{ label: 'Try again', onPress: refreshGitHubProject }}
      />
    )
  }
  if (githubProjectTable && !githubProjectRepoSlugReady) {
    return renderMobileTasksStatePage(model, <StateView loading title="Matching repositories…" />)
  }
  if (!githubProjectTable || visibleGitHubProjectRows.length === 0) {
    return renderMobileTasksStatePage(
      model,
      <StateView
        icon={Inbox}
        title="No project items"
        message="This view has no items that match. Try another view or search."
      />
    )
  }
  return (
    <FlatList
      style={styles.page}
      data={githubProjectListEntries}
      keyExtractor={(entry) => (entry.type === 'group' ? `group:${entry.group.key}` : entry.row.id)}
      ListHeaderComponent={renderMobileTasksChrome(model)}
      onScroll={onPageScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'group' || trailingItem?.type === 'group' ? null : (
          <View style={styles.separator} />
        )
      }
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      renderItem={({ item: entry }) => {
        if (entry.type === 'group') {
          return (
            <SectionHeader
              title={`${entry.group.label || 'Items'} · ${projectGroupMeta(entry.group)}`}
              expanded={!entry.collapsed}
              onToggle={() =>
                setCollapsedGitHubProjectGroups((current) => {
                  const next = new Set(current)
                  if (next.has(entry.group.key)) {
                    next.delete(entry.group.key)
                  } else {
                    next.add(entry.group.key)
                  }
                  return next
                })
              }
            />
          )
        }
        const row = entry.row
        const repo = findProjectRowRepo(row)
        const fieldBadges: TaskRowBadge[] = githubProjectSummaryFields
          .map((field) => ({
            field,
            value: projectFieldDisplayLabel(row, field)
          }))
          .filter(({ value }) => value !== 'Empty')
          .slice(0, MAX_FIELD_BADGES)
          .map(({ field, value }) => ({
            key: field.id,
            label: `${field.name}: ${value}`,
            tone: 'neutral'
          }))
        const meta = [
          `${row.content.repository ?? githubProjectTable.project.title}${
            row.content.number ? ` #${row.content.number}` : ''
          }`,
          formatUpdatedAt(row.updatedAt)
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <MobileTaskRow
            title={row.content.title}
            meta={meta}
            metaDotColor={getRepoBadgeColor(repo ?? undefined, row.content.repository ?? 'project')}
            status={projectRowStatusGlyph(row, projectRowStatusLabel(row))}
            badges={fieldBadges}
            onPress={() => setProjectRowItem(row)}
          />
        )
      }}
    />
  )
}
