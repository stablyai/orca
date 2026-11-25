import { Pressable, Text, View } from 'react-native'
import type { GitCommitAction } from '../../../../src/shared/git/commands/git-commit-action'
import type { GitConflictOperation } from '../../../../src/shared/git/status/git-status-types'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { styles } from '../mobile-source-control-styles'
import { mobileConflictAbortLabel } from './mobile-source-control-conflict-abort'

export function isSequencerOperation(
  operation: GitConflictOperation | null
): operation is GitCommitAction {
  return operation === 'cherry-pick' || operation === 'revert'
}

export function sequencerLabel(operation: GitCommitAction, t: Translate): string {
  return operation === 'revert'
    ? t('sourceControl.changesHeader.revert', 'Revert')
    : t('sourceControl.changesHeader.cherryPick', 'Cherry-pick')
}

// Desktop's SequencerRecoveryControls; Continue waits while conflicts are listed, since git refuses it then.
export function MobileSequencerRecoveryButtons({
  operation,
  busyAction,
  unresolved,
  onContinue,
  onAbort
}: {
  operation: GitCommitAction
  busyAction: string | null
  unresolved: number
  onContinue: () => void
  onAbort: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const busy = busyAction !== null
  const continuing = busyAction === `continue-${operation}`
  const aborting = busyAction === `abort-${operation}`
  const canContinue = !busy && unresolved === 0
  const label = sequencerLabel(operation, t)
  return (
    <View style={styles.sequencerButtons}>
      <Pressable
        style={({ pressed }) => [
          styles.sequencerContinue,
          !canContinue && styles.abortButtonDisabled,
          pressed && canContinue && styles.abortPressed
        ]}
        disabled={!canContinue}
        onPress={onContinue}
        accessibilityRole="button"
        accessibilityLabel={t(
          'sourceControl.changesHeader.continueSequencer',
          'Continue {{operation}}',
          {
            operation: label
          }
        )}
      >
        <Text style={styles.sequencerContinueText}>
          {continuing
            ? t('sourceControl.changesHeader.continuing', 'Continuing…')
            : t('sourceControl.changesHeader.continue', 'Continue')}
        </Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.abortButton,
          styles.sequencerAbort,
          busy && styles.abortButtonDisabled,
          pressed && !busy && styles.abortPressed
        ]}
        disabled={busy}
        onPress={onAbort}
        accessibilityRole="button"
        accessibilityLabel={mobileConflictAbortLabel(operation, aborting)}
      >
        <Text style={styles.abortText}>
          {aborting
            ? mobileConflictAbortLabel(operation, true)
            : t('sourceControl.changesHeader.abort', 'Abort')}
        </Text>
      </Pressable>
    </View>
  )
}
