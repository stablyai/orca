import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  View,
  ActivityIndicator,
  colors,
  Text,
  Pressable,
  FlatList,
  spacing,
  ChevronDown,
  triggerMediumImpact,
  TaskProviderLogo
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectGroupMeta,
  formatUpdatedAt,
  getRepoBadgeColor,
  projectFieldDisplayLabel,
  projectRowStatusLabel
} from './mobile-tasks-legacy-foundation'

export function renderMobileTasksGitHubProjectList(model: ConnectionPresentationModel) {
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
    refreshGitHubProject,
    setCollapsedGitHubProjectGroups,
    setProjectRowItem,
    setShowGitHubProjectPicker,
    taskUiReady,
    visibleGitHubProjectRows
  } = model
  return githubProjectLoading ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : !activeGitHubProject ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>Choose a GitHub project</Text>
      <Pressable
        style={[styles.targetButton, styles.centerActionButton]}
        disabled={!taskUiReady}
        onPress={() => {
          if (!taskUiReady) {
            return
          }
          setShowGitHubProjectPicker(true)
        }}
      >
        <Text style={styles.targetButtonText}>Browse projects</Text>
      </Pressable>
    </View>
  ) : githubProjectError ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{githubProjectError}</Text>
    </View>
  ) : githubProjectTable && !githubProjectRepoSlugReady ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : !githubProjectTable || visibleGitHubProjectRows.length === 0 ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>No project items</Text>
    </View>
  ) : (
    <FlatList
      data={githubProjectListEntries}
      keyExtractor={(entry) => (entry.type === 'group' ? `group:${entry.group.key}` : entry.row.id)}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      refreshing={githubProjectLoading}
      onRefresh={refreshGitHubProject}
      renderItem={({ item: entry }) => {
        if (entry.type === 'group') {
          return (
            <Pressable
              style={styles.projectGroupHeader}
              onPress={() =>
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
            >
              <ChevronDown
                size={14}
                color={colors.textMuted}
                style={entry.collapsed ? styles.projectGroupChevronCollapsed : undefined}
              />
              <Text style={styles.projectGroupTitle} numberOfLines={1}>
                {entry.group.label || 'Items'}
              </Text>
              <Text style={styles.projectGroupMeta}>{projectGroupMeta(entry.group)}</Text>
            </Pressable>
          )
        }
        const row = entry.row
        const repo = findProjectRowRepo(row)
        return (
          <Pressable
            style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
            onPress={() => {
              triggerMediumImpact()
              setProjectRowItem(row)
            }}
          >
            <View style={styles.taskIcon}>
              <TaskProviderLogo provider="github" size={15} color={colors.textSecondary} />
            </View>
            <View style={styles.taskMain}>
              <View style={styles.taskTitleRow}>
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {row.content.title}
                </Text>
                <Text style={styles.updatedAt}>{formatUpdatedAt(row.updatedAt)}</Text>
              </View>
              <View style={styles.metaRow}>
                <View
                  style={[
                    styles.repoDot,
                    {
                      backgroundColor: getRepoBadgeColor(
                        repo ?? undefined,
                        row.content.repository ?? 'project'
                      )
                    }
                  ]}
                />
                <Text style={styles.subtitle} numberOfLines={1}>
                  {row.itemType === 'PULL_REQUEST'
                    ? 'Pull request'
                    : row.itemType === 'ISSUE'
                      ? 'Issue'
                      : 'Project item'}{' '}
                  · {row.content.repository ?? githubProjectTable.project.title}
                  {row.content.number ? ` #${row.content.number}` : ''}
                </Text>
              </View>
              {githubProjectSummaryFields.length > 0 ? (
                <View style={styles.projectFieldPillRow}>
                  {githubProjectSummaryFields.slice(0, 4).map((field) => {
                    const value = projectFieldDisplayLabel(row, field)
                    const isEmpty = value === 'Empty'
                    return (
                      <View key={field.id} style={styles.projectFieldPill}>
                        <Text style={styles.projectFieldPillText} numberOfLines={1}>
                          {field.name}:{' '}
                          <Text style={isEmpty ? styles.projectFieldPillEmptyText : undefined}>
                            {value}
                          </Text>
                        </Text>
                      </View>
                    )
                  })}
                  {githubProjectSummaryFields.length > 4 ? (
                    <View style={styles.projectFieldPill}>
                      <Text style={styles.projectFieldPillText}>
                        +{githubProjectSummaryFields.length - 4} fields
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
            <View style={styles.statusPill}>
              <Text style={styles.statusText} numberOfLines={1}>
                {projectRowStatusLabel(row)}
              </Text>
            </View>
          </Pressable>
        )
      }}
    />
  )
}
