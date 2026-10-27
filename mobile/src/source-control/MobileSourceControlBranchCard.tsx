import { Pressable, Text, View } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
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
  prChip,
  onOpenPr
}: Props) {
  useMobileColorScheme()
  const showConflict = conflictOperation !== null && conflictOperation !== 'unknown'
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
        <Text style={styles.countText}>{unstagedCount} changed</Text>
        <Text style={styles.countText}>{stagedCount} staged</Text>
        {branchCount > 0 ? <Text style={styles.countText}>{branchCount} on branch</Text> : null}
      </View>
      {/* Keep Abort on its own row so long counts cannot overflow the card. */}
      {showConflict ? (
        <View style={styles.conflictRow}>
          <Text style={styles.conflictText}>{conflictOperation}</Text>
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
