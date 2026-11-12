import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { HostKindIcon } from './HostKindIcon'
import { LIST_LEADING_INSET, ListGroup, ListRow } from './list/ListGroup'
import { MobileSearchField } from './MobileSearchField'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import type { NewWorkspaceProjectOption } from './new-workspace-project-targets'
import { listNewWorkspaceHosts, quickPickNewWorkspaceTargets } from './new-workspace-project-search'

const QUICK_PICK_LIMIT = 5

/** Search projects (or tap a run target) to set the project and where it runs in one pick. */
export function NewWorktreeQuickPick(props: {
  projects: NewWorkspaceProjectOption<MobileWorkspaceRepo>[]
  repos: MobileWorkspaceRepo[]
  hostLabelFor: (repo: MobileWorkspaceRepo) => string
  onPick: (repo: MobileWorkspaceRepo) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [hostId, setHostId] = useState<string | null>(null)
  const { repos, hostLabelFor, projects } = props
  const hosts = useMemo(() => listNewWorkspaceHosts(repos, hostLabelFor), [repos, hostLabelFor])
  const active = query.trim() !== '' || hostId !== null
  const picks = useMemo(
    () =>
      active
        ? quickPickNewWorkspaceTargets(
            projects,
            repos,
            query,
            hostLabelFor,
            hostId,
            QUICK_PICK_LIMIT
          )
        : [],
    [active, projects, repos, query, hostLabelFor, hostId]
  )

  return (
    <View style={styles.root}>
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('components.newWorktreeQuickPick.placeholder', 'Search projects')}
      />
      {hosts.length > 1 ? (
        <View style={styles.chipRow}>
          {hosts.map((host) => {
            const selected = host.id === hostId
            return (
              <Pressable
                key={host.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={t(
                  'components.newWorktreeQuickPick.filterByHost',
                  'Filter by {{host}}',
                  {
                    host: host.label
                  }
                )}
                style={[styles.chip, selected && styles.chipSelected]}
                onPress={() => setHostId(selected ? null : host.id)}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {host.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
      {active ? (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {picks.length === 0 ? (
            <ListRow
              key="empty"
              title={t('components.newWorktreeQuickPick.noMatches', 'No matches')}
            />
          ) : (
            picks.map((pick) => (
              <ListRow
                key={pick.id}
                title={pick.label}
                subtitle={pick.hostLabel}
                leading={<HostKindIcon hostId={getRepoExecutionHostId(pick.repo)} size={18} />}
                onPress={() => {
                  setQuery('')
                  setHostId(null)
                  props.onPick(pick.repo)
                }}
              />
            ))
          )}
        </ListGroup>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  root: {
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  chipSelected: {
    backgroundColor: colors.sheetGroup,
    borderColor: colors.textSecondary
  },
  chipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  chipTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600'
  }
}))
