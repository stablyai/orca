import { MobileNativeChatForm } from './MobileNativeChatForm'
import type { MobilePermissionResponse } from './mobile-native-chat-permission'
import { memo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ShieldQuestion } from 'lucide-react-native'
import { approvalBlockedPathToShow } from '../../../../../src/shared/agent-session-approval-blocked-path'
import { MobileNativeChatCardHeaderAction } from '../../MobileNativeChatCardHeaderAction'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject
} from '../../../../../src/shared/agent-session-approval-subject'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { openExternalLink, useExternalLinkAvailable } from '../../../platform/external-link'

function MobileNativeChatPermissionImpl({
  permission,
  onRespond,
  onCancel,
  onCollapse
}: {
  permission: MobileChatPermission
  onRespond: MobilePermissionResponse
  onCancel?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const linkAvailable = useExternalLinkAvailable(permission.url)
  // Unknown newer-host subjects allow only cancellation; preserve their detail for the reader.
  const newerSubject = isNewerApprovalSubject(permission.subject)
  const respond = async (...args: Parameters<MobilePermissionResponse>): Promise<boolean> => {
    if (submittingRef.current) {
      return false
    }
    submittingRef.current = true
    setSubmitting(true)
    const accepted = await onRespond(...args)
    if (!accepted) {
      submittingRef.current = false
      setSubmitting(false)
    }
    return accepted
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
          {permission.title}
        </Text>
        <MobileNativeChatCardHeaderAction
          prompt={permission.prompt}
          onCancel={onCancel}
          onCollapse={onCollapse}
          disabled={submitting}
        />
      </View>
      <MobileNativeChatPermissionContext permission={permission} newerSubject={newerSubject} />
      {permission.form && !newerSubject ? (
        <MobileNativeChatForm
          form={permission.form}
          disabled={submitting}
          submitDisabled={permission.formSubmitEnabled === false}
          onSubmit={(content) => respond('', content, permission.prompt)}
        />
      ) : null}
      <View testID="native-chat-approval-actions" style={styles.options}>
        {permission.url ? (
          <Pressable
            accessibilityRole="button"
            disabled={submitting || !linkAvailable}
            accessibilityState={{ disabled: submitting || !linkAvailable }}
            style={[
              styles.option,
              styles.optionSecondary,
              (submitting || !linkAvailable) && styles.disabled
            ]}
            onPress={() => permission.url && openExternalLink(permission.url)}
          >
            <Text style={styles.optionText}>{t('chat.permission.openLink', 'Open link')}</Text>
          </Pressable>
        ) : null}
        {permission.options.map((option, index) => {
          const isPrimary = index === 0 && !permission.form
          return (
            <Pressable
              key={`${option.send}:${option.label}`}
              style={({ pressed }) => [
                styles.option,
                isPrimary ? styles.optionPrimary : styles.optionSecondary,
                pressed && !submitting && styles.optionPressed,
                newerSubject && styles.disabled
              ]}
              hitSlop={6}
              onPress={() => respond(option.send)}
              disabled={submitting || newerSubject}
            >
              <Text style={[styles.optionText, isPrimary && styles.optionTextPrimary]}>
                {option.label}
              </Text>
            </Pressable>
          )
        })}
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
          <MobileMarkdown content={permission.subject.text} />
          {permission.subject.filePath ? (
            <Text style={styles.planFile}>
              {t('chat.permission.planFile', 'Plan file: {{filePath}}', {
                filePath: permission.subject.filePath
              })}
            </Text>
          ) : null}
        </View>
      ) : permission.detail ? (
        <Text style={styles.detail}>{permission.detail}</Text>
      ) : null}
      {newerSubject ? (
        <Text testID="native-chat-approval-needs-newer-orca" style={styles.detail}>
          {t('chat.permission.newerVersionRequired', 'This request needs a newer version of Orca.')}
        </Text>
      ) : null}
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.card,
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
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  optionPrimary: {
    backgroundColor: colors.accentBlue
  },
  optionSecondary: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
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
  }
}))
