import { Pressable, Text, View } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-source-control-styles'
import { MobileSourceControlPrChip } from './MobileSourceControlPrChip'
import type { MobilePrChipSummary } from './mobile-pr-chip-summary'
import { mobileConflictAbortLabel } from './mobile-source-control-conflict-abort'

type Props = {
  branchLabel: string
  syncLabel: string | null
  unstagedCount: number
  stagedCount: number
  branchCount: number
  conflictOperation: string | null
  conflictBusy: boolean
  conflictAborting: boolean
  onAbortConflict: (operation: string) => void
  /** Set once a paused merge has no unresolved conflicts left. */
  onCompleteMerge: (() => void) | null
  completingMerge: boolean
  prChip: MobilePrChipSummary | null
  onOpenPr: () => void
}

export function MobileSourceControlBranchCard({
  branchLabel,
  syncLabel,
  unstagedCount,
  stagedCount,
  branchCount,
  conflictOperation,
  conflictBusy,
  conflictAborting,
  onAbortConflict,
  onCompleteMerge,
  completingMerge,
  prChip,
  onOpenPr
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const showConflict = conflictOperation !== null && conflictOperation !== 'unknown'
  const conflictLabel =
    conflictOperation === 'merge'
      ? t('sourceControl.branchCard.mergeState', 'merge')
      : conflictOperation === 'rebase'
        ? t('sourceControl.branchCard.rebaseState', 'rebase')
        : conflictOperation === 'cherry-pick'
          ? t('sourceControl.branchCard.cherryPickState', 'cherry-pick')
          : conflictOperation
  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryHeader}>
        <View style={styles.branchLine}>
          <GitBranch size={15} color={colors.textSecondary} strokeWidth={2.1} />
          <Text style={styles.branchText} numberOfLines={1}>
            {branchLabel}
          </Text>
        </View>
        {syncLabel ? <Text style={styles.syncText}>{syncLabel}</Text> : null}
      </View>
      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {t('sourceControl.branchCard.changedCount', '{{count}} changed', {
            count: unstagedCount
          })}
        </Text>
        <Text style={styles.countText}>
          {t('sourceControl.branchCard.stagedCount', '{{count}} staged', { count: stagedCount })}
        </Text>
        {branchCount > 0 ? (
          <Text style={styles.countText}>
            {t('sourceControl.branchCard.branchCount', '{{count}} on branch', {
              count: branchCount
            })}
          </Text>
        ) : null}
      </View>
      {/* Keep Abort on its own row so long counts cannot overflow the card. */}
      {showConflict ? (
        <View style={styles.conflictRow}>
          <Text style={styles.conflictText}>{conflictLabel}</Text>
          {onCompleteMerge ? (
            <Pressable
              style={({ pressed }) => [
                styles.completeMergeButton,
                conflictBusy && styles.abortButtonDisabled,
                pressed && !conflictBusy && styles.abortPressed
              ]}
              disabled={conflictBusy}
              onPress={onCompleteMerge}
            >
              <Text style={styles.completeMergeText}>
                {completingMerge
                  ? t('sourceControl.branchCard.completingMerge', 'Completing…')
                  : t('sourceControl.branchCard.completeMerge', 'Complete merge')}
              </Text>
            </Pressable>
          ) : null}
          {conflictOperation === 'merge' || conflictOperation === 'rebase' ? (
            <Pressable
              style={({ pressed }) => [
                styles.abortButton,
                conflictBusy && styles.abortButtonDisabled,
                pressed && !conflictBusy && styles.abortPressed
              ]}
              disabled={conflictBusy}
              onPress={() => onAbortConflict(conflictOperation)}
            >
              <Text style={styles.abortText}>
                {mobileConflictAbortLabel(conflictOperation, conflictAborting)}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {prChip ? <MobileSourceControlPrChip summary={prChip} onPress={onOpenPr} /> : null}
    </View>
  )
}
