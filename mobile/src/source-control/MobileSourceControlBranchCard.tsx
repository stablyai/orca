import { Text, View } from 'react-native'
import { AlertTriangle, GitBranch } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
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
  // True while any serial git IO is in flight — disables Abort so ops don't race.
  conflictBusy: boolean
  // True only while abort-merge / abort-rebase itself is running (label accuracy).
  conflictAborting: boolean
  onAbortConflict: (operation: string) => void
  // The PR chip is shown only on repos with a hosted-review remote; null hides it.
  prChip: MobilePrChipSummary | null
  onOpenPr: () => void
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Quiet header above every hub segment but the PR one: branch identity, sync and counts,
// conflict state, and the PR row. Shared so History sees the same status Changes does.
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
  const showConflict = conflictOperation !== null && conflictOperation !== 'unknown'
  const counts = [
    syncLabel,
    `${unstagedCount} changed`,
    `${stagedCount} staged`,
    branchCount > 0 ? `${branchCount} on branch` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <View style={styles.branchHeader}>
      <View style={styles.branchHeaderText}>
        <View style={styles.branchLine}>
          <GitBranch size={16} color={colors.textMuted} strokeWidth={2.1} />
          <Text style={styles.branchText} numberOfLines={1} ellipsizeMode="middle">
            {branchLabel}
          </Text>
        </View>
        <Text style={styles.countText} numberOfLines={2}>
          {counts}
        </Text>
      </View>
      {showConflict ? (
        <View style={styles.conflictBlock} accessibilityRole="alert">
          <AlertTriangle size={18} color={colors.statusAmber} strokeWidth={2.2} />
          <Text style={styles.conflictText}>{capitalize(conflictOperation)} in progress</Text>
          {conflictOperation === 'merge' || conflictOperation === 'rebase' ? (
            <Button
              label={capitalize(mobileConflictAbortLabel(conflictOperation, conflictAborting))}
              size="compact"
              variant="secondary"
              busy={conflictAborting}
              disabled={conflictBusy}
              onPress={() => onAbortConflict(conflictOperation)}
            />
          ) : null}
        </View>
      ) : null}
      {prChip ? <MobileSourceControlPrChip summary={prChip} onPress={onOpenPr} /> : null}
    </View>
  )
}
