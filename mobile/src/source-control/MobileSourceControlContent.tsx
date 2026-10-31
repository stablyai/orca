import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Minus, MoreHorizontal, Plus, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MessageBox } from '../components/composer-input/MessageBox'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { MobileSourceControlCreatePrEntry } from './MobileSourceControlCreatePrEntry'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { MobileSourceControlFileList } from './MobileSourceControlFileList'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

const INITIAL_COMMIT_BAR_HEIGHT = 180

type Props = {
  state: Omit<MobileSourceControlState, 'primaryActionArgs'>
  // The panel builds it once it knows the branch's review.
  primaryAction: MobileSourceControlPrimaryAction
}

export function MobileSourceControlContent({ state, primaryAction }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    insets,
    connState,
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    setShowActionSheet,
    setDiscardTarget,
    actionError,
    commitFailureRecovery,
    commitFailureRecoveryAction,
    keyboardLift,
    openingPath,
    openingBranchPath,
    sections,
    hasVisibleChanges,
    status,
    stageablePaths,
    unstageablePaths,
    stagedCount,
    createPrAction,
    stageAll,
    unstageAll,
    generateCommitMessage,
    cancelGenerateCommitMessage,
    openFile,
    openBranchDiff,
    resolveConflict,
    runGitAction
  } = state
  const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
  // A capped all-staged prefix can hide unstaged rows.
  const canStageAll = stageablePaths.length > 0 || status?.didHitLimit === true
  const shouldShowGenerateButton = stagedCount > 0 || generatingMessage
  // Typed text blocks regeneration; the same button cancels active generation.
  const generateBlockedByMessage = !generatingMessage && commitMessage.trim().length > 0
  const generateDisabled = busyAction !== null || generateBlockedByMessage
  const createPrHeroActive =
    createPrAction.visible && !createPrAction.disabled && !createPrAction.pushFirst
  // Measured, because the commit box grows as the message wraps; the first frame uses a one-line bar.
  const [commitBarHeight, setCommitBarHeight] = useState(INITIAL_COMMIT_BAR_HEIGHT)
  const listBottomInset = commitBarHeight + spacing.lg
  const fileList = useMemo(
    () => (
      <MobileSourceControlFileList
        bottomInset={listBottomInset}
        state={{
          sections,
          openFile,
          resolveConflict,
          runGitAction,
          setDiscardTarget,
          shouldShowBranchCompareSection: state.shouldShowBranchCompareSection,
          branchCompareSummaryText: state.branchCompareSummaryText,
          branchEntries: state.branchEntries,
          branchCompareState: state.branchCompareState,
          branchCompareResult: state.branchCompareResult,
          busyAction,
          openBranchDiff,
          openingBranchPath,
          openingPath
        }}
      />
    ),
    [
      listBottomInset,
      sections,
      openFile,
      resolveConflict,
      runGitAction,
      setDiscardTarget,
      state.shouldShowBranchCompareSection,
      state.branchCompareSummaryText,
      state.branchEntries,
      state.branchCompareState,
      state.branchCompareResult,
      busyAction,
      openBranchDiff,
      openingBranchPath,
      openingPath
    ]
  )

  return (
    <>
      {connState !== 'connected' ? (
        // Retained rows look actionable offline; show reconnect state beside them.
        <View style={styles.reconnectBanner}>
          <ActivityIndicator size="small" color={colors.statusAmber} />
          <Text style={styles.reconnectBannerText}>
            {t('sourceControl.content.reconnecting', 'Reconnecting to desktop...')}
          </Text>
        </View>
      ) : null}
      <View style={hubStyles.changesControls}>
        {commitFailureRecovery ? (
          <MobileCommitFailurePanel
            failure={commitFailureRecovery}
            action={commitFailureRecoveryAction}
          />
        ) : actionError ? (
          <View style={styles.actionError}>
            <Text style={styles.actionErrorText} numberOfLines={2}>
              {actionError}
            </Text>
          </View>
        ) : null}
        <MobileSourceControlCreatePrEntry action={createPrAction} />
        <View style={styles.bulkRow}>
          <Pressable
            style={({ pressed }) => [
              styles.bulkButton,
              (!canStageAll || ioBusy) && styles.bulkButtonDisabled,
              pressed && styles.bulkButtonPressed
            ]}
            onPress={() => void stageAll()}
            disabled={ioBusy || !canStageAll}
          >
            {busyAction === 'stage-all' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
            )}
            <Text style={styles.bulkButtonText}>
              {t('sourceControl.content.stageAll', 'Stage All')}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.bulkButton,
              (unstageablePaths.length === 0 || ioBusy) && styles.bulkButtonDisabled,
              pressed && styles.bulkButtonPressed
            ]}
            onPress={() => void unstageAll()}
            disabled={ioBusy || unstageablePaths.length === 0}
          >
            {busyAction === 'unstage-all' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Minus size={15} color={colors.textPrimary} strokeWidth={2.2} />
            )}
            <Text style={styles.bulkButtonText}>
              {t('sourceControl.content.unstageAll', 'Unstage All')}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.bulkMenuButton,
              pressed && styles.bulkButtonPressed,
              ioBusy && styles.bulkButtonDisabled
            ]}
            onPress={() => setShowActionSheet(true)}
            disabled={ioBusy}
            hitSlop={8}
            accessibilityLabel={t(
              'sourceControl.content.openActions',
              'Open source control actions'
            )}
          >
            <MoreHorizontal size={18} color={colors.textPrimary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </View>

      {!hasVisibleChanges ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>
            {t('sourceControl.content.emptyTitle', 'No local changes')}
          </Text>
          <Text style={styles.stateText}>
            {t('sourceControl.content.emptyMessage', 'Working tree is clean.')}
          </Text>
        </View>
      ) : (
        fileList
      )}

      <View
        onLayout={(event) => setCommitBarHeight(event.nativeEvent.layout.height)}
        style={[
          styles.commitBar,
          {
            bottom: keyboardLift > 0 ? keyboardLift + KEYBOARD_COMMIT_BAR_CLEARANCE : keyboardLift,
            paddingBottom: keyboardLift > 0 ? spacing.md : spacing.md + insets.bottom
          }
        ]}
      >
        <MessageBox
          value={stagedCount === 0 ? '' : commitMessage}
          onChangeText={setCommitMessage}
          placeholder={
            stagedCount === 0
              ? t('sourceControl.content.noStagedFiles', 'No staged files')
              : t('sourceControl.content.commitMessagePlaceholder', 'Commit message')
          }
          editable={stagedCount > 0 && !ioBusy}
          accessibilityLabel={
            stagedCount === 0
              ? t(
                  'sourceControl.content.commitMessageDisabled',
                  'Commit message disabled. No staged files.'
                )
              : undefined
          }
          leading={
            shouldShowGenerateButton ? (
              <Pressable
                style={({ pressed }) => [
                  composerInputStyles.controlButton,
                  generateDisabled && composerInputStyles.disabled,
                  pressed && composerInputStyles.pressed
                ]}
                // Keep commit-message AI with commit actions so Stage All remains unambiguous.
                disabled={generateDisabled}
                accessibilityState={{ disabled: generateDisabled }}
                accessibilityHint={
                  generateBlockedByMessage
                    ? t('sourceControl.content.regenerateHint', 'Clear the message to regenerate.')
                    : undefined
                }
                onPress={() =>
                  generatingMessage ? cancelGenerateCommitMessage() : void generateCommitMessage()
                }
                accessibilityLabel={
                  generatingMessage
                    ? t(
                        'sourceControl.content.cancelGeneration',
                        'Cancel commit message generation'
                      )
                    : t('sourceControl.content.generateMessage', 'Generate commit message with AI')
                }
              >
                {generatingMessage ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Sparkles size={17} color={colors.textSecondary} strokeWidth={2} />
                )}
              </Pressable>
            ) : null
          }
          trailing={
            <Pressable
              style={({ pressed }) => [
                styles.commitButton,
                createPrHeroActive && styles.commitButtonSecondary,
                primaryAction.disabled && styles.commitButtonDisabled,
                pressed && composerInputStyles.pressed
              ]}
              onPress={primaryAction.onPress}
              disabled={primaryAction.disabled}
              accessibilityLabel={primaryAction.accessibilityLabel}
              accessibilityHint={primaryAction.accessibilityHint}
            >
              {primaryAction.loading ? (
                <ActivityIndicator
                  size="small"
                  color={
                    createPrHeroActive || primaryAction.disabled
                      ? colors.textPrimary
                      : colors.bgBase
                  }
                />
              ) : (
                <Text
                  style={[
                    styles.commitButtonText,
                    createPrHeroActive && styles.commitButtonSecondaryText,
                    primaryAction.disabled && styles.commitButtonDisabledText
                  ]}
                >
                  {primaryAction.label}
                </Text>
              )}
            </Pressable>
          }
        />
      </View>
    </>
  )
}
