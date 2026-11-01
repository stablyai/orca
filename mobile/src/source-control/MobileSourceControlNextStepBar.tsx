import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  GitMerge,
  GitPullRequest,
  Sparkles,
  type LucideIcon
} from 'lucide-react-native'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MessageBox } from '../components/composer-input/MessageBox'
import { composerInputStyles } from '../components/composer-input/composer-input-styles'
import { KEYBOARD_COMMIT_BAR_CLEARANCE } from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'
import { AgentLaunchNotice } from '../components/AgentLaunchNotice'
import { ConfirmModal } from '../components/ConfirmModal'
import type { MobileMergeConfirm } from './use-mobile-source-control-next-step'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import type { PrAiTriageLaunchNotice } from '../session/use-mobile-pr-ai-triage'
import type {
  MobileNextStepBarView,
  MobileNextStepIcon,
  MobileNextStepTone
} from './mobile-source-control-next-step'
import { styles as sourceControlStyles } from './mobile-source-control-styles'

const ICONS: Record<MobileNextStepIcon, LucideIcon> = {
  push: ArrowUp,
  pull: ArrowDown,
  sync: ArrowDownUp,
  review: GitPullRequest,
  agent: Sparkles,
  merge: GitMerge,
  complete: Check
}

type ComposerState = Pick<
  MobileSourceControlState,
  | 'busyAction'
  | 'commitMessage'
  | 'setCommitMessage'
  | 'generatingMessage'
  | 'stagedCount'
  | 'generateCommitMessage'
  | 'cancelGenerateCommitMessage'
>

type Props = {
  view: MobileNextStepBarView
  composer: ComposerState
  primaryAction: MobileSourceControlPrimaryAction
  keyboardLift: number
  bottomInset: number
  /** A failed bar action, e.g. a push the remote rejected. */
  notice: string | null
  /** How the last "Fix/Resolve with" launch went, with its prompt when it wasn't delivered. */
  agentNotice: (PrAiTriageLaunchNotice & { availability: MobileAgentLaunchAvailability }) | null
  /** Set while Merge waits for the user to confirm. */
  mergeConfirm: MobileMergeConfirm | null
  onHeightChange: (height: number) => void
}

/** The one next action for the branch, at the foot of both Source Control tabs. */
export function MobileSourceControlNextStepBar({
  view,
  composer,
  primaryAction,
  keyboardLift,
  bottomInset,
  notice,
  agentNotice,
  mergeConfirm,
  onHeightChange
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [composerFocused, setComposerFocused] = useState(false)
  // The bar rides the keyboard only for its own commit box; for any other field it steps aside.
  const lift = composerFocused && view.kind === 'composer' ? keyboardLift : 0
  if ((view.kind === 'hidden' && !notice) || (keyboardLift > 0 && lift === 0)) {
    return null
  }
  const reason = view.kind === 'button' ? view.reason : null
  return (
    <View
      onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}
      style={[
        styles.bar,
        {
          bottom: lift > 0 ? lift + KEYBOARD_COMMIT_BAR_CLEARANCE : 0,
          paddingBottom: lift > 0 ? spacing.md : spacing.md + bottomInset
        }
      ]}
    >
      {agentNotice ? <AgentLaunchNotice {...agentNotice} errorStyle={styles.reasonError} /> : null}
      {notice ? (
        <Text style={[styles.reason, styles.reasonError]} numberOfLines={3}>
          {notice}
        </Text>
      ) : null}
      {reason ? (
        <Text style={styles.reason} numberOfLines={2}>
          {reason.lead ? <Text style={styles.reasonLead}>{reason.lead} </Text> : null}
          {reason.text}
        </Text>
      ) : null}
      {view.kind === 'composer' ? (
        <CommitComposer
          composer={composer}
          primaryAction={primaryAction}
          onFocusChange={setComposerFocused}
        />
      ) : view.kind === 'button' ? (
        <BarButton
          label={view.label}
          Icon={ICONS[view.icon]}
          tone={view.tone}
          disabled={view.disabled}
          loading={view.loading}
          accessibilityHint={view.accessibilityHint ?? reason?.text}
          onPress={view.onPress}
        />
      ) : view.kind === 'auto_merge_on' ? (
        <View style={styles.row}>
          <View style={[styles.button, styles.buttonOff, styles.grow]}>
            <GitMerge size={17} color={colors.mergeGreen} strokeWidth={2.2} />
            <Text style={[styles.label, styles.labelSecondary]} numberOfLines={1}>
              {t('sourceControl.nextStep.willMergeWhenReady', 'Will merge when ready')}
            </Text>
          </View>
          <BarButton
            label={t('sourceControl.nextStep.cancelAutoMerge', 'Cancel')}
            tone="secondary"
            disabled={view.loading || view.disabled}
            loading={view.loading}
            accessibilityLabel={t(
              'sourceControl.nextStep.cancelAutoMergeLabel',
              'Cancel auto-merge'
            )}
            onPress={view.onCancel}
          />
        </View>
      ) : view.kind === 'merged' ? (
        <View style={styles.merged}>
          <GitMerge size={16} color={colors.statusPurple} strokeWidth={2.2} />
          <Text style={styles.mergedText} numberOfLines={1}>
            {view.baseRef
              ? t('sourceControl.nextStep.mergedInto', 'Merged into {{base}}', {
                  base: view.baseRef
                })
              : t('sourceControl.nextStep.merged', 'Merged')}
          </Text>
        </View>
      ) : null}
      <ConfirmModal
        visible={mergeConfirm !== null}
        title={mergeConfirm?.title ?? ''}
        message={mergeConfirm?.message}
        confirmLabel={mergeConfirm?.confirmLabel ?? ''}
        onConfirm={() => mergeConfirm?.onConfirm()}
        onCancel={() => mergeConfirm?.onCancel()}
      />
    </View>
  )
}

function BarButton({
  label,
  Icon,
  tone,
  disabled,
  loading,
  accessibilityLabel,
  accessibilityHint,
  onPress
}: {
  label: string
  Icon?: LucideIcon
  tone: MobileNextStepTone
  disabled: boolean
  loading: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  onPress: () => void
}) {
  useMobileColorScheme()
  const off = disabled && !loading
  const fg = off
    ? colors.textMuted
    : tone === 'merge'
      ? colors.onMergeGreen
      : tone === 'secondary'
        ? colors.textPrimary
        : colors.bgBase
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'merge' && styles.buttonMerge,
        off && styles.buttonOff,
        tone === 'secondary' && Icon === undefined && styles.buttonCompact,
        Icon !== undefined && styles.grow,
        pressed && styles.pressed
      ]}
      disabled={disabled || loading}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : Icon ? (
        <Icon size={17} color={fg} strokeWidth={2.2} />
      ) : null}
      <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

function CommitComposer({
  composer,
  primaryAction,
  onFocusChange
}: {
  composer: ComposerState
  primaryAction: MobileSourceControlPrimaryAction
  onFocusChange: (focused: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    busyAction,
    commitMessage,
    setCommitMessage,
    generatingMessage,
    stagedCount,
    generateCommitMessage,
    cancelGenerateCommitMessage
  } = composer
  const ioBusy = busyAction !== null
  // Unmounting a focused field sends no blur, so let go of focus on the way out.
  useEffect(() => () => onFocusChange(false), [onFocusChange])
  const shouldShowGenerateButton = stagedCount > 0 || generatingMessage
  // Typed text blocks regeneration; the same button cancels active generation.
  const generateBlockedByMessage = !generatingMessage && commitMessage.trim().length > 0
  const generateDisabled = busyAction !== null || generateBlockedByMessage
  return (
    <MessageBox
      value={stagedCount === 0 ? '' : commitMessage}
      onChangeText={setCommitMessage}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      placeholder={t('sourceControl.content.commitMessagePlaceholder', 'Commit message')}
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
                ? t('sourceControl.content.cancelGeneration', 'Cancel commit message generation')
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
            sourceControlStyles.commitButton,
            primaryAction.disabled && sourceControlStyles.commitButtonDisabled,
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
              color={primaryAction.disabled ? colors.textPrimary : colors.bgBase}
            />
          ) : (
            <Text
              style={[
                sourceControlStyles.commitButtonText,
                primaryAction.disabled && sourceControlStyles.commitButtonDisabledText
              ]}
            >
              {primaryAction.label}
            </Text>
          )}
        </Pressable>
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.bgBase
  },
  reason: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  reasonLead: { color: colors.textPrimary, fontWeight: '600' },
  reasonError: { color: colors.statusRed, fontSize: typography.metaSize, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.sm },
  grow: { flex: 1 },
  button: {
    minHeight: 48,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceBright,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  buttonSecondary: { backgroundColor: colors.bgRaised },
  buttonMerge: { backgroundColor: colors.mergeGreen },
  buttonOff: { backgroundColor: colors.bgRaised },
  buttonCompact: { flexGrow: 0 },
  pressed: { opacity: feedback.pressedOpacity },
  label: { fontSize: typography.bodySize, fontWeight: '600' },
  labelSecondary: { color: colors.textPrimary },
  merged: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  mergedText: { color: colors.textSecondary, fontSize: typography.bodySize }
}))
