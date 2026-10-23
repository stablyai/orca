import { useMemo, useState } from 'react'
import { Keyboard, Text, View } from 'react-native'
import { CheckCircle2, Sparkles, X } from 'lucide-react-native'
import { spacing } from '../theme/mobile-theme'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { ReplyBox } from '../components/ui/ReplyBox'
import { StateView } from '../components/ui/StateView'
import { MobileSourceControlCreatePrEntry } from './MobileSourceControlCreatePrEntry'
import { MobileCommitFailurePanel } from './MobileCommitFailurePanel'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import { MobileSourceControlFileList } from './MobileSourceControlFileList'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

type Props = {
  state: MobileSourceControlState
}

// Before the bar has laid out once; about one line of message plus its padding.
const INITIAL_COMMIT_BAR_HEIGHT = 80

function primaryLabel(kind: string, label: string, stagedCount: number): string {
  if (kind !== 'commit' || stagedCount <= 1) {
    return label
  }
  return `Commit ${stagedCount} files`
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
  const [commitBarHeight, setCommitBarHeight] = useState(INITIAL_COMMIT_BAR_HEIGHT)
  // Why: a capped listing can hide unstaged rows behind an all-staged prefix.
  const canStageAll = stageablePaths.length > 0 || status?.didHitLimit === true
  const canUnstageAll = unstageablePaths.length > 0
  // Why: as on desktop, a typed message blocks regenerating; while generating the button cancels.
  const generateBlockedByMessage = !generatingMessage && commitMessage.trim().length > 0
  // Hidden rather than dimmed once a message is typed, which gives the field its width back.
  const showGenerate = (stagedCount > 0 || generatingMessage) && !generateBlockedByMessage
  const createPrHeroActive =
    createPrAction.visible && !createPrAction.disabled && !createPrAction.pushFirst
  const listBottomInset = commitBarHeight + spacing.lg
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
          openingPath,
          stageAll,
          unstageAll,
          canStageAll,
          canUnstageAll,
          bottomInset: listBottomInset
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
      openingPath,
      stageAll,
      unstageAll,
      canStageAll,
      canUnstageAll,
      listBottomInset
    ]
  )

  const commitButton = (
    <Button
      label={primaryLabel(primaryAction.kind, primaryAction.label, stagedCount)}
      variant={createPrHeroActive ? 'secondary' : 'primary'}
      size="compact"
      busy={primaryAction.loading}
      disabled={primaryAction.disabled}
      onPress={() => {
        Keyboard.dismiss()
        primaryAction.onPress()
      }}
      accessibilityLabel={primaryAction.accessibilityLabel}
      accessibilityHint={primaryAction.accessibilityHint}
    />
  )

  return (
    <>
      <View style={hubStyles.changesControls}>
        {connState !== 'connected' ? (
          // Why: once data has loaded the screen looks alive even when the
          // desktop link is down, so taps appear to do nothing (STA-1511).
          // Surface the reconnect state where the user is looking.
          <Banner tone="warning" message="Reconnecting to desktop…" />
        ) : null}
        {commitFailureRecovery ? (
          <MobileCommitFailurePanel
            failure={commitFailureRecovery}
            action={commitFailureRecoveryAction}
          />
        ) : actionError ? (
          <Banner tone="error" message={actionError} />
        ) : null}
        <MobileSourceControlCreatePrEntry action={createPrAction} />
      </View>

      {!hasVisibleChanges ? (
        <View style={[styles.emptyState, { paddingBottom: listBottomInset }]}>
          <StateView
            icon={CheckCircle2}
            title="No local changes"
            message="The working tree is clean."
          />
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
        {stagedCount === 0 && !generatingMessage ? (
          <View style={styles.commitIdleRow}>
            <Text
              style={styles.commitIdleText}
              accessibilityLabel="Commit message disabled. No staged files."
            >
              No staged files
            </Text>
            {commitButton}
          </View>
        ) : (
          <ReplyBox
            value={commitMessage}
            onChangeText={setCommitMessage}
            onSend={primaryAction.onPress}
            placeholder={generatingMessage ? 'Writing a message…' : 'Commit message'}
            maxLines={8}
            editable={busyAction === null}
            actionsBelow
            testID="source-control-commit-message"
            trailing={
              <View style={styles.commitTrailing}>
                {showGenerate ? (
                  <Button
                    label={generatingMessage ? 'Stop' : 'Generate'}
                    icon={generatingMessage ? X : Sparkles}
                    size="compact"
                    variant="secondary"
                    // Why: commit-message AI belongs to the commit path; Stage All keeps it idle.
                    disabled={busyAction !== null}
                    onPress={() =>
                      generatingMessage
                        ? cancelGenerateCommitMessage()
                        : void generateCommitMessage()
                    }
                    accessibilityLabel={
                      generatingMessage
                        ? 'Cancel commit message generation'
                        : 'Generate commit message with AI'
                    }
                  />
                ) : null}
                {commitButton}
              </View>
            }
          />
        )}
      </View>
    </>
  )
}
