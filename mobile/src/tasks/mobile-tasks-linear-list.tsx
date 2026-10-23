import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  FlatList,
  Inbox,
  SearchX,
  colors,
  radii,
  spacing,
  textStyles
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { createLinearTask, linearIssueSecondaryParts } from './mobile-tasks-legacy-foundation'
import { MobileTaskRow } from './mobile-tasks-task-row'
import { linearStateGlyph } from './mobile-tasks-status-glyph'
import { renderMobileTasksChrome } from './mobile-tasks-screen-chrome'
import { renderMobileTasksStatePage } from './mobile-tasks-list-surface'
import { clearMobileTasksSearch } from './mobile-tasks-search-control'
import { pressTransition } from '../components/ui/transition-styles'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'

export function renderMobileTasksLinearList(model: PageChromeModel) {
  const {
    effectiveLinearDisplayProperties,
    emptyLabel,
    hasUserQuery,
    insets,
    linearBoardSections,
    linearIssuesForView,
    linearListEntries,
    linearViewMode,
    loading,
    mutatingStatus,
    onPageScroll,
    setActionItem,
    setLinearStatusPickerItem
  } = model
  if (loading) {
    return renderMobileTasksStatePage(model, <StateView loading title="Loading Linear issues…" />)
  }
  if (linearIssuesForView.length === 0) {
    return renderMobileTasksStatePage(
      model,
      hasUserQuery ? (
        <StateView
          icon={SearchX}
          title={emptyLabel}
          message="Try different words, or clear the search."
          secondary={{
            label: 'Clear search',
            onPress: () => clearMobileTasksSearch(model)
          }}
        />
      ) : (
        <StateView
          icon={Inbox}
          title={emptyLabel}
          message="Nothing matches this filter. Try another filter or team."
        />
      )
    )
  }
  const showState = effectiveLinearDisplayProperties.has('state')
  if (linearViewMode === 'board') {
    // Columns scroll sideways and each scrolls on its own, so the header stays put above them.
    return (
      <View style={styles.page}>
        {renderMobileTasksChrome(model)}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[
            boardStyles.container,
            { paddingBottom: spacing.lg + insets.bottom }
          ]}
        >
          {linearBoardSections.map((section) => (
            <View key={section.key} style={boardStyles.column}>
              <View style={boardStyles.header}>
                <View style={[styles.repoSectionDot, { backgroundColor: section.color }]} />
                <Text style={boardStyles.title} numberOfLines={1}>
                  {section.label}
                </Text>
                <Text style={boardStyles.count}>{section.issues.length}</Text>
              </View>
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={boardStyles.cards}
              >
                {section.issues.map((issue) => {
                  const task = createLinearTask(issue)
                  const glyph = linearStateGlyph(issue.state)
                  return (
                    <Pressable
                      key={issue.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${issue.title}, ${issue.state.name}`}
                      onPress={() => setActionItem(task)}
                    >
                      {({ pressed }) => (
                        <View
                          style={[
                            boardStyles.card,
                            pressed && boardStyles.cardPressed,
                            pressed ? pressTransition.pressed : pressTransition.rest
                          ]}
                        >
                          <Text style={boardStyles.cardTitle} numberOfLines={3}>
                            {issue.title}
                          </Text>
                          <Text style={boardStyles.cardMeta} numberOfLines={2}>
                            {linearIssueSecondaryParts(
                              issue,
                              effectiveLinearDisplayProperties
                            ).join(' · ')}
                          </Text>
                          {showState ? (
                            <Pressable
                              style={boardStyles.stateButton}
                              disabled={mutatingStatus}
                              accessibilityRole="button"
                              accessibilityLabel={`Change status from ${issue.state.name}`}
                              onPress={(event) => {
                                event.stopPropagation()
                                setLinearStatusPickerItem(task)
                              }}
                            >
                              <glyph.icon size={15} color={glyph.color} strokeWidth={2.2} />
                              <Text style={boardStyles.stateText} numberOfLines={1}>
                                {issue.state.name}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      )}
                    </Pressable>
                  )
                })}
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      </View>
    )
  }
  return (
    <FlatList
      style={styles.page}
      data={linearListEntries}
      keyExtractor={(entry) =>
        entry.type === 'section' ? `linear-section:${entry.section.key}` : entry.issue.id
      }
      ListHeaderComponent={renderMobileTasksChrome(model)}
      onScroll={onPageScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <View style={styles.separator} />
        )
      }
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      renderItem={({ item: entry }) => {
        if (entry.type === 'section') {
          return <SectionHeader title={entry.section.label} count={entry.section.issues.length} />
        }
        const issue = entry.issue
        const linearTask = createLinearTask(issue)
        return (
          <MobileTaskRow
            title={issue.title}
            meta={linearIssueSecondaryParts(issue, effectiveLinearDisplayProperties).join(' · ')}
            status={showState ? linearStateGlyph(issue.state) : null}
            onStatusPress={showState ? () => setLinearStatusPickerItem(linearTask) : undefined}
            statusDisabled={mutatingStatus}
            onPress={() => setActionItem(linearTask)}
          />
        )
      }}
    />
  )
}

const BOARD_PADDING = spacing.sm

const boardStyles = StyleSheet.create({
  container: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  column: {
    width: 288,
    maxHeight: '100%',
    borderRadius: radii.group,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md + 2
  },
  title: {
    ...textStyles.subhead,
    flex: 1,
    fontWeight: '600',
    color: colors.textPrimary
  },
  count: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  cards: { gap: BOARD_PADDING, padding: BOARD_PADDING, paddingTop: 0 },
  // Concentric with the column: its radius minus the padding around the cards.
  card: {
    borderRadius: radii.group - BOARD_PADDING,
    backgroundColor: colors.fill,
    padding: spacing.md,
    gap: spacing.xs
  },
  cardPressed: { backgroundColor: colors.fillPressed },
  cardTitle: {
    ...textStyles.callout,
    fontWeight: '500',
    color: colors.textPrimary
  },
  cardMeta: { ...textStyles.footnote, color: colors.textSecondary },
  stateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    minHeight: 44,
    marginBottom: -spacing.sm
  },
  stateText: { ...textStyles.footnote, color: colors.textSecondary }
})
