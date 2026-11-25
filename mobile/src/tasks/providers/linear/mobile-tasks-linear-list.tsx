import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import { translate } from '../../../i18n/mobile-i18n'
import { View, Text, ScrollView, Pressable, FlatList } from 'react-native'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { SectionHeader } from '../../../components/list/ListGroup'
import { MobileTaskRow, MobileTaskRowSeparator } from '../../task-list/mobile-task-row'
import { colors, spacing, type MobileColorScheme, pressedStyle } from '../../../theme/mobile-theme'
import { ChevronDown } from 'lucide-react-native'
import {
  ignoreKeptRowPress,
  renderMobileTasksListState
} from '../../task-list/mobile-tasks-list-state'
import { styles } from '../../mobile-tasks-legacy-styles'
import { createLinearTask } from '../../item-detail/mobile-tasks-item-mapping'
import type { TaskItem } from '../../mobile-tasks-project-workspace-types'
import { linearIssueSecondaryParts } from '../../item-detail/mobile-tasks-reviewer-linear'

export function renderMobileTasksLinearList(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme,
  bottomBarHeight: number
) {
  const {
    effectiveLinearDisplayProperties,
    insets,
    linearBoardSections,
    linearIssuesForView,
    linearFilterLabel,
    linearListEntries,
    linearViewMode,
    mutatingStatus,
    refreshTasks,
    refreshing,
    taskUiReady
  } = model
  // The last list, kept before Tasks is ready, is read-only.
  const setActionItem = taskUiReady ? model.setActionItem : ignoreKeptRowPress
  const setLinearStatusPickerItem = taskUiReady
    ? model.setLinearStatusPickerItem
    : ignoreKeptRowPress
  const listState = renderMobileTasksListState(model, linearIssuesForView.length, bottomBarHeight)
  if (listState) {
    return listState
  }
  return linearViewMode === 'board' ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[
        styles.boardContainer,
        { paddingBottom: spacing.lg + Math.max(insets.bottom, bottomBarHeight) }
      ]}
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
                    style={({ pressed }) => [
                      styles.statusPillSelf,
                      styles.linearStatePill,
                      pressed && pressedStyle
                    ]}
                    disabled={mutatingStatus}
                    accessibilityRole="button"
                    accessibilityLabel={translate(
                      'tasks.linearList.changeStatusFrom',
                      'Change status from {{status}}',
                      {
                        status: issue.state.name
                      }
                    )}
                    onPress={(event) => {
                      event.stopPropagation()
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
      extraData={colorScheme}
      keyExtractor={(entry) =>
        entry.type === 'section' ? `linear-section:${entry.section.key}` : entry.issue.id
      }
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <MobileTaskRowSeparator />
        )
      }
      contentContainerStyle={{
        paddingBottom: spacing.lg + Math.max(insets.bottom, bottomBarHeight)
      }}
      ListHeaderComponent={
        linearListEntries[0]?.type === 'section' ? undefined : (
          <View style={listStyles.heading}>
            <SectionHeader title={linearFilterLabel} first />
          </View>
        )
      }
      refreshing={refreshing}
      onRefresh={refreshTasks}
      renderItem={({ item: entry, index }) => {
        if (entry.type === 'section') {
          return (
            <View style={listStyles.heading}>
              <SectionHeader
                title={entry.section.label}
                trailing={String(entry.section.issues.length)}
                first={index === 0}
              />
            </View>
          )
        }
        const issue = entry.issue
        const linearTask = createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>
        const edge = (neighbour: (typeof linearListEntries)[number] | undefined) =>
          neighbour === undefined || neighbour.type === 'section'
        return (
          <MobileTaskRow
            item={linearTask}
            first={edge(linearListEntries[index - 1])}
            last={edge(linearListEntries[index + 1])}
            meta={[
              effectiveLinearDisplayProperties.has('state') ? issue.state.name : '',
              ...linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties)
            ]
              .filter(Boolean)
              .join(' · ')}
            onPress={() => setActionItem(linearTask)}
          />
        )
      }}
    />
  )
}

const listStyles = themedStyleSheet(() => ({
  heading: { marginHorizontal: spacing.lg }
}))
