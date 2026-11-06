import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { SectionHeader } from '../components/list/ListGroup'
import { colors, radii, spacing, typography, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileCommitsListItem } from './mobile-git-history'

type RowAction = { busy: boolean; disabled: boolean; onPress: () => void }
type LabeledRowAction = RowAction & { label: string }
type CommitItem = Extract<MobileCommitsListItem, { kind: 'commit' }>
type BaseItem = Extract<MobileCommitsListItem, { kind: 'base' }>

// Zero sides are dropped, like desktop's diff stats.
export function CommitLineStat({ added, removed }: { added: number; removed: number }) {
  useMobileColorScheme()
  if (added === 0 && removed === 0) {
    return null
  }
  return (
    <Text style={styles.stat}>
      {added > 0 ? <Text style={styles.added}>+{added}</Text> : null}
      {added > 0 && removed > 0 ? ' ' : null}
      {removed > 0 ? <Text style={styles.removed}>−{removed}</Text> : null}
    </Text>
  )
}

export function CommitsSectionHeader({
  title,
  push
}: {
  title: string
  push: LabeledRowAction | null
}) {
  return (
    <SectionHeader
      title={title}
      trailing={
        push === null ? undefined : push.busy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={push.disabled}
            onPress={push.onPress}
            style={({ pressed }) => [
              styles.sectionAction,
              push.disabled && styles.disabled,
              pressed && pressedStyle
            ]}
          >
            <Text style={styles.sectionActionText}>{push.label}</Text>
          </Pressable>
        )
      }
    />
  )
}

export function BranchBaseRow({ item, update }: { item: BaseItem; update: RowAction | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const baseRef = item.baseRefName
  return (
    <View style={styles.row}>
      <Timeline lineAbove={item.lineAbove} lineBelow={false} marker="base" />
      <View style={styles.rowMain}>
        <View style={styles.rowText}>
          <Text style={styles.subject} numberOfLines={1}>
            {t('sourceControl.commits.branchedFrom', 'Branched from {{baseRef}}', { baseRef })}
          </Text>
          {/* The title names the base, so the line under it only counts what the base gained. */}
          <Text style={styles.meta} numberOfLines={1}>
            {item.behind === 0
              ? t('sourceControl.commits.baseUpToDate', 'Up to date')
              : item.behind === 1
                ? t('sourceControl.commits.baseNewer_one', '1 newer commit', { count: 1 })
                : t('sourceControl.commits.baseNewer_other', '{{count}} newer commits', {
                    count: item.behind
                  })}
          </Text>
        </View>
        {update === null ? null : update.busy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={update.disabled}
            onPress={update.onPress}
            style={({ pressed }) => [
              styles.pillButton,
              update.disabled && styles.disabled,
              pressed && pressedStyle
            ]}
          >
            <Text style={styles.pillButtonText}>
              {t('sourceControl.commits.updateBranch', 'Update branch')}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

// A plain element builder, not a component, so the list's renderItem returns the pressable row itself.
export function renderCommitRow(item: CommitItem, onPress: (id: string) => void) {
  const { row } = item
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(row.id)}
      accessibilityRole="button"
      accessibilityLabel={row.subject}
    >
      <Timeline
        lineAbove={item.lineAbove}
        lineBelow={item.lineBelow}
        marker={item.pushed === false ? 'hollow' : 'filled'}
      />
      <View style={[styles.rowMain, styles.rowDivider]}>
        <View style={styles.rowText}>
          <Text style={styles.subject} numberOfLines={1}>
            {row.subject}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[row.shortId, row.author, row.relativeTime].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <CommitLineStat added={row.insertions} removed={row.deletions} />
        <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

// Hollow dots are commits origin does not have yet, as in the approved mock.
function Timeline({
  lineAbove,
  lineBelow,
  marker
}: {
  lineAbove: boolean
  lineBelow: boolean
  marker: 'hollow' | 'filled' | 'base'
}) {
  useMobileColorScheme()
  return (
    <View style={styles.timeline}>
      <View style={[styles.line, !lineAbove && styles.lineHidden]} />
      <View
        style={
          marker === 'hollow'
            ? styles.dotHollow
            : marker === 'base'
              ? styles.dotBase
              : styles.dotFilled
        }
      />
      <View style={[styles.line, !lineBelow && styles.lineHidden]} />
    </View>
  )
}

const DOT = 10

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    minHeight: 56
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  rowText: { flex: 1, minWidth: 0 },
  subject: { color: colors.textPrimary, fontSize: typography.bodySize },
  meta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  timeline: { width: DOT + spacing.md, alignItems: 'flex-start' },
  line: {
    flex: 1,
    width: 1,
    marginLeft: DOT / 2,
    backgroundColor: colors.translucentFill
  },
  lineHidden: { backgroundColor: 'transparent' },
  dotFilled: {
    width: DOT,
    height: DOT,
    borderRadius: radii.pill,
    backgroundColor: colors.textMuted
  },
  dotHollow: {
    width: DOT,
    height: DOT,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.accentBlue
  },
  dotBase: {
    width: DOT,
    height: DOT,
    borderRadius: 2,
    borderWidth: 1.5,
    borderColor: colors.textMuted
  },
  sectionAction: { paddingVertical: spacing.xs, paddingLeft: spacing.sm },
  sectionActionText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pillButton: {
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  pillButtonText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  stat: { fontSize: typography.metaSize, fontFamily: typography.monoFamily },
  added: { color: colors.gitDecorationAdded },
  removed: { color: colors.gitDecorationDeleted }
}))
