import { memo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ShieldQuestion } from 'lucide-react-native'
import { approvalDetailPreview } from '../../../../../src/shared/agent-session/agent-session-approval-detail-preview'
import { approvalBlockedPathToShow } from '../../../../../src/shared/agent-session/agent-session-approval-blocked-path'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { MobileNativeChatMarkdown } from '../transcript/MobileNativeChatMarkdown'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject,
  isUrlApprovalSubject,
  URL_APPROVAL_DECLINE_OPTION_ID,
  URL_APPROVAL_OPEN_OPTION_ID
} from '../../../../../src/shared/agent-session/agent-session-approval-subject'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import {
  canOpenUrlRequestPage,
  MobileNativeChatUrlTarget,
  openUrlRequestPage
} from './MobileNativeChatUrlRequest'
import { structuredApprovalOptionId } from './mobile-structured-agent-prompts'

function MobileNativeChatPermissionImpl({
  permission,
  onRespond,
  onCancel,
  onCollapse,
  onAnswerInTerminal
}: {
  permission: MobileChatPermission
  onRespond: (send: string) => Promise<boolean>
  /** Shown when the card has no options: only the terminal can answer it. */
  onAnswerInTerminal?: () => void
  onCancel?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  // Unknown newer-host subjects allow only cancellation; preserve their detail for the reader.
  const newerSubject = isNewerApprovalSubject(permission.subject)
  // A page to open: its option opens it, and the back-out stays quiet.
  const url = isUrlApprovalSubject(permission.subject) ? permission.subject.url : null
  const title = url === null ? permission.title : t('chat.urlRequest.title', 'Sign-in requested')
  const optionLabel = (option: MobileChatPermission['options'][number]): string =>
    url === null
      ? option.label
      : structuredApprovalOptionId(option.send) === URL_APPROVAL_OPEN_OPTION_ID
        ? t('chat.urlRequest.open', 'Open sign-in page')
        : structuredApprovalOptionId(option.send) === URL_APPROVAL_DECLINE_OPTION_ID
          ? t('chat.urlRequest.decline', 'Decline')
          : option.label
  const respond = async (send: string): Promise<void> => {
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    const accepted = await onRespond(send)
    if (!accepted) {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return (
    <View testID="native-chat-approval-card" style={styles.card}>
      <View style={styles.header}>
        <ShieldQuestion size={16} color={colors.accentBlue} strokeWidth={2} />
        <Text
          testID="native-chat-approval-title"
          style={styles.title}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {title}
        </Text>
        <MobileNativeChatCardHeaderAction
          prompt={permission.prompt}
          onCancel={onCancel}
          onCollapse={onCollapse}
          disabled={submitting}
        />
      </View>
      <MobileNativeChatPermissionContext permission={permission} newerSubject={newerSubject} />
      <View testID="native-chat-approval-actions" style={styles.options}>
        {permission.options.map((option, index) => {
          const isPrimary = index === 0 && !permission.neutralOptions
          const opensUrl =
            url !== null && structuredApprovalOptionId(option.send) === URL_APPROVAL_OPEN_OPTION_ID
          const unopenable = opensUrl && !canOpenUrlRequestPage(url)
          return (
            <Pressable
              key={`${option.send}:${option.label}`}
              style={({ pressed }) => [
                styles.option,
                isPrimary
                  ? styles.optionPrimary
                  : url === null
                    ? styles.optionSecondary
                    : styles.optionQuiet,
                pressed && !submitting && styles.optionPressed,
                (newerSubject || unopenable) && styles.disabled
              ]}
              hitSlop={6}
              onPress={() => {
                if (opensUrl && !submittingRef.current) {
                  openUrlRequestPage(url)
                }
                void respond(option.send)
              }}
              disabled={submitting || newerSubject || unopenable}
            >
              <Text
                style={[
                  styles.optionText,
                  isPrimary && styles.optionTextPrimary,
                  !isPrimary && url !== null && styles.optionTextQuiet
                ]}
              >
                {optionLabel(option)}
              </Text>
            </Pressable>
          )
        })}
        {permission.options.length === 0 && onAnswerInTerminal ? (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.option,
              styles.optionPrimary,
              pressed && styles.optionPressed
            ]}
            hitSlop={6}
            onPress={onAnswerInTerminal}
          >
            <Text style={[styles.optionText, styles.optionTextPrimary]}>
              {t('chat.promptCard.answerInTerminal', 'Answer in terminal')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

export const MobileNativeChatPermission = memo(MobileNativeChatPermissionImpl)

function MobileNativeChatPermissionContext({
  permission,
  newerSubject
}: {
  permission: MobileChatPermission
  newerSubject: boolean
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const neededPath = approvalBlockedPathToShow(permission)
  if (
    !permission.description &&
    !permission.decisionReason &&
    !neededPath &&
    !permission.subject &&
    !permission.detail
  ) {
    return null
  }
  return (
    <ScrollView
      testID="native-chat-approval-content"
      style={styles.contentScroll}
      contentContainerStyle={styles.content}
      nestedScrollEnabled
    >
      {permission.description ? <Text style={styles.detail}>{permission.description}</Text> : null}
      {permission.decisionReason ? (
        <Text style={styles.detail}>
          <Text style={styles.contextLabel}>{t('chat.permission.reason', 'Reason: ')}</Text>
          {permission.decisionReason}
        </Text>
      ) : null}
      {neededPath ? (
        <Text style={styles.detail}>
          <Text style={styles.contextLabel}>
            {t('chat.permission.needsAccessTo', 'Needs access to: ')}
          </Text>
          {neededPath}
        </Text>
      ) : null}
      {isPlanApprovalSubject(permission.subject) ? (
        <View>
          <MobileNativeChatMarkdown content={permission.subject.text} />
          {permission.subject.filePath ? (
            <Text style={styles.planFile}>
              {t('chat.permission.planFile', 'Plan file: {{filePath}}', {
                filePath: permission.subject.filePath
              })}
            </Text>
          ) : null}
        </View>
      ) : isUrlApprovalSubject(permission.subject) ? (
        <MobileNativeChatUrlTarget url={permission.subject.url} />
      ) : permission.detail ? (
        <MobileNativeChatPermissionDetail detail={permission.detail} />
      ) : null}
      {newerSubject ? (
        <Text testID="native-chat-approval-needs-newer-orca" style={styles.detail}>
          {t('chat.permission.newerVersionRequired', 'This request needs a newer version of Orca.')}
        </Text>
      ) : null}
    </ScrollView>
  )
}

function MobileNativeChatPermissionDetail({ detail }: { detail: string }): React.JSX.Element {
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const preview = approvalDetailPreview(detail)
  return (
    <View style={styles.content}>
      {preview !== detail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          hitSlop={8}
        >
          <Text style={[styles.detail, styles.contextLabel]}>
            {expanded ? t('common.hideDetails', 'Hide details') : t('common.details', 'Details')}
          </Text>
        </Pressable>
      ) : null}
      <Text selectable style={styles.detail}>
        {expanded ? detail : preview}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    flexShrink: 1,
    minHeight: 0
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  detail: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + 5
  },
  planFile: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + 5
  },
  contextLabel: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  contentScroll: {
    maxHeight: 240,
    minHeight: 0,
    flexShrink: 1
  },
  content: {
    gap: spacing.sm
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    flexShrink: 0
  },
  option: {
    minHeight: 44,
    // A long menu label wraps inside its button instead of running off the card.
    maxWidth: '100%',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  optionPrimary: {
    backgroundColor: colors.accentBlue
  },
  optionSecondary: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  optionQuiet: {
    backgroundColor: 'transparent'
  },
  optionPressed: {
    opacity: 0.7
  },
  disabled: {
    opacity: 0.5
  },
  optionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionTextPrimary: {
    color: colors.onAccent
  },
  optionTextQuiet: {
    color: colors.textSecondary
  }
}))
