import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  View,
  ActivityIndicator,
  colors,
  Text,
  ScrollView,
  spacing,
  Pressable,
  triggerMediumImpact,
  ChevronDown,
  FlatList,
  TaskProviderLogo
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  createLinearTask,
  type TaskItem,
  linearIssueSecondaryParts,
  formatUpdatedAt
} from './mobile-tasks-legacy-foundation'

export function renderMobileTasksLinearList(model: ConnectionPresentationModel) {
  const {
    effectiveLinearDisplayProperties,
    emptyLabel,
    insets,
    linearBoardSections,
    linearIssuesForView,
    linearListEntries,
    linearViewMode,
    loading,
    mutatingStatus,
    refreshTasks,
    refreshing,
    setActionItem,
    setLinearStatusPickerItem
  } = model
  return loading ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : linearIssuesForView.length === 0 ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{emptyLabel}</Text>
    </View>
  ) : linearViewMode === 'board' ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.boardContainer, { paddingBottom: spacing.lg + insets.bottom }]}
    >
      {linearBoardSections.map((section) => (
        <View key={section.key} style={styles.boardColumn}>
          <View style={styles.boardHeader}>
            <View style={[styles.repoSectionDot, { backgroundColor: section.color }]} />
            <Text style={styles.boardTitle} numberOfLines={1}>
              {section.label}
            </Text>
            <Text style={styles.boardCount}>{section.issues.length}</Text>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            {section.issues.map((issue) => (
              <Pressable
                key={issue.id}
                style={({ pressed }) => [styles.boardCard, pressed && styles.taskRowPressed]}
                onPress={() => {
                  triggerMediumImpact()
                  setActionItem(
                    createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
                  )
                }}
              >
                <Text style={styles.taskTitle} numberOfLines={3}>
                  {issue.title}
                </Text>
                <Text style={styles.subtitle} numberOfLines={2}>
                  {linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties).join(' · ')}
                </Text>
                {effectiveLinearDisplayProperties.has('state') ? (
                  <Pressable
                    style={[styles.statusPillSelf, styles.linearStatePill]}
                    disabled={mutatingStatus}
                    accessibilityRole="button"
                    accessibilityLabel={`Change status from ${issue.state.name}`}
                    onPress={(event) => {
                      event.stopPropagation()
                      triggerMediumImpact()
                      setLinearStatusPickerItem(
                        createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
                      )
                    }}
                  >
                    <View
                      style={[
                        styles.linearStateDot,
                        { backgroundColor: issue.state.color || colors.textMuted }
                      ]}
                    />
                    <Text style={[styles.statusText, styles.statusTextFlex]} numberOfLines={1}>
                      {issue.state.name}
                    </Text>
                    <ChevronDown size={12} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  ) : (
    <FlatList
      data={linearListEntries}
      keyExtractor={(entry) =>
        entry.type === 'section' ? `linear-section:${entry.section.key}` : entry.issue.id
      }
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <View style={styles.separator} />
        )
      }
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      refreshing={refreshing}
      onRefresh={refreshTasks}
      renderItem={({ item: entry }) => {
        if (entry.type === 'section') {
          return (
            <View style={styles.repoSectionHeader}>
              <View style={[styles.repoSectionDot, { backgroundColor: entry.section.color }]} />
              <Text style={styles.repoSectionTitle} numberOfLines={1}>
                {entry.section.label}
              </Text>
              <Text style={styles.boardCount}>{entry.section.issues.length}</Text>
            </View>
          )
        }
        const issue = entry.issue
        const linearTask = createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
        return (
          <Pressable
            style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
            onPress={() => {
              triggerMediumImpact()
              setActionItem(linearTask)
            }}
          >
            <View style={styles.taskIcon}>
              <TaskProviderLogo provider="linear" size={15} color={colors.textSecondary} />
            </View>
            <View style={styles.taskMain}>
              <View style={styles.taskTitleRow}>
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {issue.title}
                </Text>
                {effectiveLinearDisplayProperties.has('updated') ? (
                  <Text style={styles.updatedAt}>{formatUpdatedAt(issue.updatedAt)}</Text>
                ) : null}
              </View>
              <View style={styles.metaRow}>
                <View style={[styles.repoDot, { backgroundColor: issue.state.color }]} />
                <Text style={styles.subtitle} numberOfLines={1}>
                  {linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties).join(' · ')}
                </Text>
              </View>
            </View>
            <View style={styles.linearListTrailing}>
              {effectiveLinearDisplayProperties.has('state') ? (
                <Pressable
                  style={[styles.statusPill, styles.linearStatePill]}
                  disabled={mutatingStatus}
                  accessibilityRole="button"
                  accessibilityLabel={`Change status from ${issue.state.name}`}
                  onPress={(event) => {
                    event.stopPropagation()
                    triggerMediumImpact()
                    setLinearStatusPickerItem(linearTask)
                  }}
                >
                  <View
                    style={[
                      styles.linearStateDot,
                      { backgroundColor: issue.state.color || colors.textMuted }
                    ]}
                  />
                  <Text style={[styles.statusText, styles.statusTextFlex]} numberOfLines={1}>
                    {issue.state.name}
                  </Text>
                  <ChevronDown size={12} color={colors.textSecondary} />
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        )
      }}
    />
  )
}
