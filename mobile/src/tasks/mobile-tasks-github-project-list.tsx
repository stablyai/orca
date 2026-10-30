import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
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
  TaskProviderLogo,
  type MobileColorScheme
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  projectGroupMeta,
  formatUpdatedAt,
  getRepoBadgeColor,
  projectFieldDisplayLabel,
  projectRowStatusLabel
} from './mobile-tasks-legacy-foundation'
import type { GitHubProjectField, GitHubProjectRow } from './mobile-tasks-view-state-types'

function isProjectFieldEmpty(row: GitHubProjectRow, field: GitHubProjectField): boolean {
  switch (field.dataType) {
    case 'ASSIGNEES':
      return row.content.assignees.map((user) => user.login).join(', ') === ''
    case 'LABELS':
      return row.content.labels.map((label) => label.name).join(', ') === ''
    case 'REPOSITORY':
      return row.content.repository == null
    case 'PARENT_ISSUE':
      return !row.content.parentIssue
    case 'ISSUE_TYPE':
      return row.content.issueType?.name == null
    case 'TITLE':
      return false
  }
  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return true
  }
  switch (value.kind) {
    case 'text':
      return !value.text
    case 'labels':
      return value.labels.map((label) => label.name).join(', ') === ''
    case 'users':
      return value.users.map((user) => user.login).join(', ') === ''
    case 'date':
    case 'iteration':
    case 'number':
    case 'single-select':
      return false
  }
}

export function renderMobileTasksGitHubProjectList(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme
) {
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
  const count = githubProjectSummaryFields.length - 4
  return githubProjectLoading ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : !activeGitHubProject ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>
        {translate('tasks.githubProjectList.chooseProject', 'Choose a GitHub project')}
      </Text>
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
        <Text style={styles.targetButtonText}>
          {translate('tasks.githubProjectList.browseProjects', 'Browse projects')}
        </Text>
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
      <Text style={styles.emptyText}>
        {translate('tasks.githubProjectList.noItems', 'No project items')}
      </Text>
    </View>
  ) : (
    <FlatList
      data={githubProjectListEntries}
      extraData={colorScheme}
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
                {entry.group.label || translate('tasks.githubProjectList.items', 'Items')}
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
                      backgroundColor: getRepoBadgeColor(repo ?? undefined)
                    }
                  ]}
                />
                <Text style={styles.subtitle} numberOfLines={1}>
                  {row.itemType === 'PULL_REQUEST'
                    ? translate(
                        'tasks.githubProjectList.pullRequestSubtitle',
                        'Pull request · {{repository}}{{number}}',
                        {
                          repository: row.content.repository ?? githubProjectTable.project.title,
                          number: row.content.number ? ` #${row.content.number}` : ''
                        }
                      )
                    : row.itemType === 'ISSUE'
                      ? translate(
                          'tasks.githubProjectList.issueSubtitle',
                          'Issue · {{repository}}{{number}}',
                          {
                            repository: row.content.repository ?? githubProjectTable.project.title,
                            number: row.content.number ? ` #${row.content.number}` : ''
                          }
                        )
                      : translate(
                          'tasks.githubProjectList.itemSubtitle',
                          'Project item · {{repository}}{{number}}',
                          {
                            repository: row.content.repository ?? githubProjectTable.project.title,
                            number: row.content.number ? ` #${row.content.number}` : ''
                          }
                        )}
                </Text>
              </View>
              {githubProjectSummaryFields.length > 0 ? (
                <View style={styles.projectFieldPillRow}>
                  {githubProjectSummaryFields.slice(0, 4).map((field) => {
                    const isEmpty = isProjectFieldEmpty(row, field)
                    const value = isEmpty
                      ? translate('tasks.githubProjectList.emptyField', 'Empty')
                      : projectFieldDisplayLabel(row, field)
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
                        {count === 1
                          ? translate(
                              'tasks.githubProjectList.moreFields_one',
                              '+{{count}} field',
                              { count }
                            )
                          : translate(
                              'tasks.githubProjectList.moreFields_other',
                              '+{{count}} fields',
                              { count }
                            )}
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
