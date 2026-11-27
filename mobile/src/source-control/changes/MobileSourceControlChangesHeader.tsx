import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { GitConflictOperation } from '../../../../src/shared/git/status/git-status-types'
import type { MobileSourceControlState } from '../use-mobile-source-control-state'
import { styles } from '../mobile-source-control-styles'

type HeaderState = Pick<
  MobileSourceControlState,
  'status' | 'branchLabel' | 'branchCompareResult' | 'busyAction' | 'openBranchPicker'
>

function operationLabel(operation: GitConflictOperation, t: Translate): string | null {
  switch (operation) {
    case 'merge':
      return t('sourceControl.changesHeader.merging', 'Merging')
    case 'rebase':
      return t('sourceControl.changesHeader.rebasing', 'Rebasing')
    case 'cherry-pick':
      return t('sourceControl.changesHeader.cherryPicking', 'Cherry-picking')
    case 'unknown':
      return null
  }
  return null
}

function syncMeta(
  status: MobileSourceControlState['status'],
  operation: GitConflictOperation | null,
  unresolved: number,
  t: Translate
): string | null {
  const paused = operation ? operationLabel(operation, t) : null
  if (paused) {
    // The count lives here; the Conflicts section lists the files and the bar has the next step.
    return unresolved > 0
      ? t('sourceControl.changesHeader.pausedToResolve', '{{operation}} · {{count}} to resolve', {
          operation: paused,
          count: unresolved
        })
      : paused
  }
  const upstream = status?.upstreamStatus
  if (!upstream) {
    return null
  }
  if (!upstream.hasUpstream) {
    return t('sourceControl.changesHeader.notPublished', 'Not published')
  }
  if (upstream.ahead > 0 && upstream.behind > 0) {
    return t('sourceControl.state.syncStatus', '{{ahead}} ahead, {{behind}} behind', upstream)
  }
  if (upstream.ahead > 0) {
    return t('sourceControl.changesHeader.notPushed', '{{count}} not pushed', {
      count: upstream.ahead
    })
  }
  if (upstream.behind > 0) {
    return t('sourceControl.changesHeader.behind', '{{count}} behind', { count: upstream.behind })
  }
  return t('sourceControl.changesHeader.upToDate', 'Up to date')
}

/** Above the Changes list: the branch and its sync state (or a paused merge's), and the Commits row. */
export function MobileSourceControlChangesHeader({
  state,
  onOpenCommits
}: {
  state: HeaderState
  onOpenCommits: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { status, busyAction } = state
  const rawOperation = status?.conflictOperation ?? null
  const operation = rawOperation === 'unknown' ? null : rawOperation
  const commits = state.branchCompareResult?.summary.commitsAhead ?? 0
  const unresolved =
    status?.entries.filter((entry) => entry.conflictStatus === 'unresolved').length ?? 0
  const meta = syncMeta(status, operation, unresolved, t)
  // Only what the branch line, the list and the bar don't already say. Abort is in ⋯.
  const note =
    !operation || unresolved > 0
      ? null
      : status?.didHitLimit === true
        ? // A capped listing can hide the remaining conflicts; never claim they're done.
          t(
            'sourceControl.changesHeader.conflictsMayRemain',
            'Not every file is listed, so conflicts may remain. Check on your computer.'
          )
        : operation === 'merge'
          ? null
          : // Mobile has no continue for a rebase or cherry-pick.
            t(
              'sourceControl.changesHeader.continueOnComputerShort',
              'Continue on your computer to finish.'
            )
  return (
    <View>
      <View style={styles.statusLine}>
        <Pressable
          style={({ pressed }) => [styles.branchButton, pressed && styles.sectionActionPressed]}
          onPress={state.openBranchPicker}
          disabled={busyAction !== null}
          accessibilityRole="button"
          accessibilityLabel={t(
            'sourceControl.changesHeader.switchBranch',
            'Switch branch from {{branch}}',
            {
              branch: state.branchLabel
            }
          )}
        >
          <GitBranch size={15} color={colors.textSecondary} strokeWidth={2.1} />
          <Text style={styles.branchText} numberOfLines={1}>
            {state.branchLabel}
          </Text>
          <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.2} />
        </Pressable>
        {meta ? <Text style={styles.syncText}>{meta}</Text> : null}
      </View>
      {note ? <Text style={styles.conflictNote}>{note}</Text> : null}
      {commits > 0 ? (
        <Pressable
          style={({ pressed }) => [styles.commitsRow, pressed && styles.commitsRowPressed]}
          onPress={onOpenCommits}
          accessibilityRole="button"
        >
          <GitCommitHorizontal size={16} color={colors.textSecondary} strokeWidth={2.1} />
          <Text style={styles.commitsRowText}>
            {commits === 1
              ? t('sourceControl.changesHeader.commits_one', '{{count}} commit', { count: commits })
              : t('sourceControl.changesHeader.commits_other', '{{count}} commits', {
                  count: commits
                })}
          </Text>
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}
