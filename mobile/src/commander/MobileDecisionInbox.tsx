import { useMemo, useState } from 'react'
import { FlatList, Pressable, Text } from 'react-native'
import { groupPendingDecisions } from '../../../src/shared/commander/decision-inbox'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CommanderOverviewProps } from './commander-mobile-data'
import { useCommanderDetailBack } from './commander-detail-back'
import { useCommanderProjects } from './use-commander-projects'

export function MobileDecisionInbox({ data, handlers, active }: CommanderOverviewProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const projects = useCommanderProjects(data, active)
  const groups = useMemo(
    () =>
      groupPendingDecisions(
        projects.flatMap((project) =>
          project.rows
            .filter((row) => !row.offline && !row.stale)
            .map((row) => ({
              id: JSON.stringify([
                row.hostId,
                project.executionHostId,
                row.entry.worktreeId,
                row.key
              ]),
              state: row.dotState,
              since: row.entry.agent.stateStartedAt,
              summary: row.entry.agent.askSummary,
              value: { row, project }
            }))
        )
      ),
    [projects]
  )
  const selected = groups.find((group) => group.id === selectedId)
  useCommanderDetailBack(active && selected ? () => setSelectedId(null) : null)

  if (selected) {
    return (
      <FlatList
        key="requests"
        data={selected.requests}
        keyExtractor={(request) => request.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Pressable
            accessibilityRole="button"
            style={styles.row}
            onPress={() => setSelectedId(null)}
          >
            <Text style={styles.title}>{t('commander.inboxTab', 'Decisions')}</Text>
            <Text style={styles.meta}>
              {selected.summary || selected.requests[0]!.value.row.title}
            </Text>
          </Pressable>
        }
        renderItem={({ item }) => {
          const { row, project } = item.value
          const host = data.sortedHosts.find((h) => h.id === row.hostId)?.name ?? row.hostId
          return (
            <Pressable
              accessibilityRole="button"
              style={styles.row}
              onPress={() => handlers.onOpen(row)}
            >
              <Text style={styles.title}>{row.title}</Text>
              <Text style={styles.meta}>
                {[
                  project.name,
                  row.entry.workspaceName,
                  host,
                  project.executionHostId === 'local' ? '' : project.executionHostId
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Pressable>
          )
        }}
      />
    )
  }
  return (
    <FlatList
      key="decisions"
      data={groups}
      keyExtractor={(group) => group.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <Text style={styles.meta}>{t('commander.inboxEmpty', 'No pending agent decisions.')}</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => setSelectedId(item.id)}
          style={styles.row}
        >
          <Text style={styles.title}>{item.summary || item.requests[0]!.value.row.title}</Text>
          <Text style={styles.meta}>
            {t('commander.inboxCount', 'Requests: {{count}}', { count: item.requests.length })}
          </Text>
        </Pressable>
      )}
    />
  )
}

const styles = themedStyleSheet(() => ({
  list: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  row: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.inputBorder
  },
  title: { fontWeight: '600', fontSize: 16, color: colors.textPrimary },
  meta: { fontSize: 13, color: colors.textSecondary }
}))
