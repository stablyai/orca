import { Pressable, Text, View } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-source-control-styles'
import { MobileSourceControlPrChip } from './MobileSourceControlPrChip'
import type { MobilePrChipSummary } from './mobile-pr-chip-summary'
import {
  mobileConflictAbortLabel,
  mobileConflictContinueLabel
} from './mobile-source-control-conflict-actions'

type Props = {
  branchLabel: string
  syncLabel: string | null
  unstagedCount: number
  stagedCount: number
  branchCount: number
  conflictOperation: string | null
  // Why: git refuses `--continue` while any file is unmerged — hide the button then.
  hasUnresolvedConflicts: boolean
  // True while any serial git IO is in flight — disables Abort/Continue so ops don't race.
  conflictBusy: boolean
  // True only while abort-merge / abort-rebase itself is running (label accuracy).
  conflictAborting: boolean
  // True only while the matching continue call itself is running (label accuracy).
  conflictAdvancing: boolean
  onAbortConflict: (operation: string) => void
  onContinueConflict: (operation: string) => void
  // The PR chip is shown only on repos with a hosted-review remote; null hides it.
  prChip: MobilePrChipSummary | null
  onOpenPr: () => void
}

// Persistent card at the top of every hub segment: branch identity, sync/counts,
// conflict state, and the PR chip. Shared so PR/History see the same status the
// Changes lens does without re-deriving it.
export function MobileSourceControlBranchCard({
  branchLabel,
  syncLabel,
  unstagedCount,
  stagedCount,
  branchCount,
  conflictOperation,
  hasUnresolvedConflicts,
  conflictBusy,
  conflictAborting,
  conflictAdvancing,
  onAbortConflict,
  onContinueConflict,
  prChip,
  onOpenPr
}: Props) {
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
      {/* Own row so Abort never overflows past the card when counts are long. */}
      {showConflict ? (
        <View style={styles.conflictRow}>
          <Text style={styles.conflictText}>{conflictOperation}</Text>
          {!hasUnresolvedConflicts ? (
            <Pressable
              style={({ pressed }) => [
                styles.abortButton,
                conflictBusy && styles.abortButtonDisabled,
                pressed && !conflictBusy && styles.abortPressed
              ]}
              disabled={conflictBusy}
              onPress={() => onContinueConflict(conflictOperation)}
            >
              <Text style={styles.abortText}>
                {mobileConflictContinueLabel(conflictOperation, conflictAdvancing)}
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
