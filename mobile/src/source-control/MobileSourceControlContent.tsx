import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  SectionList,
  Text,
  TextInput,
  View
} from 'react-native'
import { Minus, MoreHorizontal, Plus, Sparkles } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileSourceControlCreatePrEntry } from './MobileSourceControlCreatePrEntry'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { makeRenderFileRow, BranchCompareFooter } from './MobileSourceControlFileRows'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

type Props = {
  state: MobileSourceControlState
}

// Changes tab: local file changes only — uncommitted (staged/unstaged) plus
// committed-on-branch vs base. PR conflicts and push status live elsewhere.
export function MobileSourceControlContent({ state }: Props) {
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
    stageablePaths,
    unstageablePaths,
    stagedCount,
    primaryAction,
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
  const shouldShowGenerateButton = stagedCount > 0 || generatingMessage
  const createPrHeroActive =
    createPrAction.visible && !createPrAction.disabled && !createPrAction.pushFirst
  const branchCompareFooter = (
    <BranchCompareFooter
      state={{
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
  )

  return (
    <>
      {connState !== 'connected' ? (
        // Why: once data has loaded the screen looks alive even when the
        // desktop link is down, so taps appear to do nothing (STA-1511).
        // Surface the reconnect state where the user is looking.
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
              (stageablePaths.length === 0 || ioBusy) && styles.bulkButtonDisabled,
              pressed && styles.bulkButtonPressed
            ]}
            onPress={() => void stageAll()}
            disabled={ioBusy || stageablePaths.length === 0}
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
      ) : sections.length === 0 ? (
        // Why: RN SectionList with empty `sections` often skips ListFooterComponent,
        // which hid "Committed on Branch" when only branch files remain.
        <ScrollView style={hubStyles.tabBody} contentContainerStyle={styles.listContent}>
          {branchCompareFooter}
        </ScrollView>
      ) : (
        <SectionList
          style={hubStyles.tabBody}
          sections={sections}
          renderItem={makeRenderFileRow({
            busyAction,
            openingPath,
            openingBranchPath,
            openFile,
            runGitAction,
            setDiscardTarget
          })}
          keyExtractor={(item) => `${item.area}:${item.path}:${item.oldPath ?? ''}`}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionCount}>{section.data.length}</Text>
            </View>
          )}
          ListFooterComponent={branchCompareFooter}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
        />
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
                busyAction !== null && styles.commitButtonDisabled,
                pressed && styles.commitButtonPressed
              ]}
              // Why: commit-message AI belongs to the commit path; hiding it
              // during Stage All keeps the quick action visually unambiguous.
              disabled={busyAction !== null}
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
