import { useMemo } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { Minus, MoreHorizontal, Plus, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileSourceControlCreatePrEntry } from './MobileSourceControlCreatePrEntry'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { MobileSourceControlFileList } from './MobileSourceControlFileList'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

type Props = {
  state: Omit<MobileSourceControlState, 'primaryActionArgs'>
  // The panel builds it once it knows the branch's review.
  primaryAction: MobileSourceControlPrimaryAction
}

export function MobileSourceControlContent({ state, primaryAction }: Props) {
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
  const fileList = useMemo(
    () => (
      <MobileSourceControlFileList
        state={{
          sections,
          openFile,
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
      sections,
      openFile,
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
          <Text style={styles.reconnectBannerText}>Reconnecting to desktop...</Text>
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
            <Text style={styles.bulkButtonText}>Stage All</Text>
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
            <Text style={styles.bulkButtonText}>Unstage All</Text>
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
            accessibilityLabel="Open source control actions"
          >
            <MoreHorizontal size={18} color={colors.textPrimary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </View>

      {!hasVisibleChanges ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>No local changes</Text>
          <Text style={styles.stateText}>Working tree is clean.</Text>
        </View>
      ) : (
        fileList
      )}

      <View
        style={[
          styles.commitBar,
          {
            bottom: keyboardLift > 0 ? keyboardLift + KEYBOARD_COMMIT_BAR_CLEARANCE : keyboardLift,
            paddingBottom: keyboardLift > 0 ? spacing.md : spacing.md + insets.bottom
          }
        ]}
      >
        <View style={styles.commitRow}>
          {stagedCount === 0 ? (
            <View
              style={[styles.commitInput, styles.commitInputDisabled]}
              accessibilityRole="text"
              accessibilityState={{ disabled: true }}
              accessibilityLabel="Commit message disabled. No staged files."
            >
              <Text style={styles.commitInputDisabledText}>No staged files</Text>
            </View>
          ) : (
            <TextInput
              style={styles.commitInput}
              value={commitMessage}
              onChangeText={setCommitMessage}
              placeholder="Commit message"
              placeholderTextColor={colors.textMuted}
              editable={busyAction === null && openingPath === null && openingBranchPath === null}
              returnKeyType="done"
              onSubmitEditing={primaryAction.onPress}
            />
          )}
          {shouldShowGenerateButton ? (
            <Pressable
              style={({ pressed }) => [
                styles.generateButton,
                generateDisabled && styles.commitButtonDisabled,
                pressed && styles.commitButtonPressed
              ]}
              // Keep commit-message AI with commit actions so Stage All remains unambiguous.
              disabled={generateDisabled}
              accessibilityState={{ disabled: generateDisabled }}
              accessibilityHint={
                generateBlockedByMessage ? 'Clear the message to regenerate.' : undefined
              }
              onPress={() =>
                generatingMessage ? cancelGenerateCommitMessage() : void generateCommitMessage()
              }
              accessibilityLabel={
                generatingMessage
                  ? 'Cancel commit message generation'
                  : 'Generate commit message with AI'
              }
            >
              {generatingMessage ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Sparkles size={16} color={colors.textSecondary} strokeWidth={2.1} />
              )}
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.commitButton,
              createPrHeroActive && styles.commitButtonSecondary,
              primaryAction.disabled && styles.commitButtonDisabled,
              pressed && styles.commitButtonPressed
            ]}
            onPress={primaryAction.onPress}
            disabled={primaryAction.disabled}
            accessibilityLabel={primaryAction.accessibilityLabel}
            accessibilityHint={primaryAction.accessibilityHint}
          >
            {primaryAction.loading ? (
              <ActivityIndicator
                size="small"
                color={createPrHeroActive ? colors.textPrimary : colors.bgBase}
              />
            ) : (
              <Text
                style={[
                  styles.commitButtonText,
                  createPrHeroActive && styles.commitButtonSecondaryText
                ]}
              >
                {primaryAction.label}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </>
  )
}
