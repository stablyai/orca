import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge, GitPullRequest, type LucideIcon } from 'lucide-react-native'
import { colors, feedback, pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { resolveGitHubPRMergeMethods } from '../../../../src/shared/github/pull-request-merge-methods'
import { resolveGitHubPRMergeState } from '../../../../src/shared/github/pull-request-merge-state'
import { MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY } from '../../../../src/shared/source-control-runtime-capabilities'
import { useRouteCapability } from '../../transport/use-workspace-client'
import { presentPrMerge } from './pr-actions-state'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { prTabStyles as styles } from './pr-tab-styles'

type Tone = 'primary' | 'merge' | 'secondary'

// The PR tab's foot: the diff-review dock always shows it, the hub only while its bar is on a local step.
export function PrTabBottomAction({ tab, bottomInset }: { tab: MobilePrTab; bottomInset: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { state, actions } = tab
  const canMarkReady = useRouteCapability(MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY)
  const footerStyle = [styles.footer, { paddingBottom: Math.max(bottomInset, 12) }]

  if (state.kind === 'none') {
    return (
      <View style={footerStyle}>
        <ActionButton
          tone="primary"
          icon={GitPullRequest}
          label={t('pullRequest.tab.createPullRequest', 'Create pull request')}
          onPress={tab.openCreatePrSheet}
          disabled={!tab.client || !tab.gitBranch}
        />
      </View>
    )
  }
  if (state.kind !== 'ready') {
    return null
  }
  const pr = state.data.pr
  const prState = actions.resolveState(pr.state)
  // Menu mutations (reopen, unlink, ready) report here whatever state the PR is left in.
  const error = actions.error ?? tab.unlinkError
  const errorLine = error ? <Text style={styles.errorText}>{error}</Text> : null
  if (prState === 'merged') {
    return (
      <View style={footerStyle}>
        {errorLine}
        <View style={styles.mergedNote}>
          <GitMerge size={16} color={colors.statusPurple} strokeWidth={2.2} />
          <Text style={styles.reason}>
            {pr.baseRefName
              ? t('pullRequest.tab.mergedInto', 'Merged into {{base}}', { base: pr.baseRefName })
              : t('pullRequest.tab.merged', 'Merged')}
          </Text>
        </View>
      </View>
    )
  }
  if (prState === 'closed') {
    return errorLine ? <View style={footerStyle}>{errorLine}</View> : null
  }
  if (prState === 'draft') {
    return canMarkReady || errorLine ? (
      <View style={footerStyle}>
        {errorLine}
        {canMarkReady ? (
          <ActionButton
            tone="secondary"
            label={t('pullRequest.prActionsSection.markReadyButton', 'Ready for review')}
            onPress={actions.markReadyForReview}
            busy={actions.isBusy({ kind: 'state' })}
          />
        ) : null}
      </View>
    ) : null
  }

  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const effective = { ...pr, state: prState, autoMergeEnabled: autoMerge }
  const { defaultMethod } = resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null)
  const merge = presentPrMerge(effective, defaultMethod)
  const decision = resolveGitHubPRMergeState(effective)
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const reason = merge.hint ? (
    <Text style={styles.reason}>
      <Text style={styles.reasonStrong}>
        {t('pullRequest.tab.cantMergeYet', 'Can’t merge yet:')}
      </Text>{' '}
      {merge.hint}
    </Text>
  ) : null

  let action
  if (merge.enabled) {
    action = (
      <ActionButton
        tone="merge"
        icon={GitMerge}
        label={merge.label}
        onPress={tab.openMergeSheet}
        busy={actions.isBusy({ kind: 'merge' })}
      />
    )
  } else if (decision.autoMergeAction === 'disable_auto_merge') {
    action = (
      <View style={styles.actionRow}>
        <ActionButton
          tone="secondary"
          icon={GitMerge}
          label={t('pullRequest.tab.willMergeWhenReady', 'Will merge when ready')}
          disabled
          grow
        />
        <ActionButton
          tone="secondary"
          label={t('common.cancel', 'Cancel')}
          onPress={() => actions.setAutoMerge(false)}
          busy={autoMergeBusy}
        />
      </View>
    )
  } else if (decision.autoMergeAction !== null && merge.showAutoMerge) {
    action = (
      <ActionButton
        tone="secondary"
        icon={GitMerge}
        label={t('pullRequest.tab.mergeWhenReady', 'Merge when ready')}
        onPress={() => actions.setAutoMerge(true, defaultMethod)}
        busy={autoMergeBusy}
      />
    )
  } else {
    action = <ActionButton tone="secondary" icon={GitMerge} label={merge.label} disabled />
  }
  return (
    <View style={footerStyle}>
      {errorLine ?? reason}
      {action}
    </View>
  )
}

function ActionButton({
  tone,
  icon: Icon,
  label,
  onPress,
  disabled = false,
  busy = false,
  grow = false
}: {
  tone: Tone
  icon?: LucideIcon
  label: string
  onPress?: () => void
  disabled?: boolean
  busy?: boolean
  /** Takes the row's spare width next to a compact Cancel. */
  grow?: boolean
}) {
  useMobileColorScheme()
  const foreground =
    tone === 'primary' ? colors.bgBase : tone === 'merge' ? colors.onMergeGreen : colors.textPrimary
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'primary'
          ? styles.actionPrimary
          : tone === 'merge'
            ? styles.actionMerge
            : styles.actionSecondary,
        grow && styles.actionGrow,
        disabled && { opacity: feedback.disabledOpacity },
        pressed && pressedStyle
      ]}
      onPress={onPress}
      disabled={disabled || busy || !onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
    >
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : Icon ? (
        <Icon size={17} color={foreground} strokeWidth={2.2} />
      ) : null}
      <Text
        style={[
          styles.actionLabel,
          tone === 'primary' && styles.actionLabelPrimary,
          tone === 'merge' && styles.actionLabelMerge
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}
