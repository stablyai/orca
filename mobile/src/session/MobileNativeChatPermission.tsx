import { memo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { ShieldQuestion } from 'lucide-react-native'
import { approvalBlockedPathToShow } from '../../../src/shared/agent-session-approval-blocked-path'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { triggerSuccess } from '../platform/haptics'
import {
  MobileNativeChatPromptCardFrame,
  promptCardStyles
} from './MobileNativeChatPromptCardFrame'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject
} from '../../../src/shared/agent-session-approval-subject'
import type { MobileChatPermission } from './mobile-native-chat-permission'

// Renders a detected agent permission ask as a card with tappable options.
// The first option is treated as the primary (allow) action and gets the card's one filled
// button so the affirmative choice reads as distinct from the rest.
function MobileNativeChatPermissionImpl({
  permission,
  onRespond,
  onCancel,
  onCollapse
}: {
  permission: MobileChatPermission
  onRespond: (send: string) => Promise<boolean>
  onCancel?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  /** Fold the card to a strip and free Send, writing nothing. */
  onCollapse?: () => void
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState<string | null>(null)
  const submittingRef = useRef(false)
  // A newer Orca's subject: its detail is shown, and only the card's cancel answers.
  const newerSubject = isNewerApprovalSubject(permission.subject)
  const respond = async (send: string): Promise<void> => {
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    setSubmitting(send)
    const accepted = await onRespond(send)
    if (accepted) {
      triggerSuccess()
    } else {
      submittingRef.current = false
      setSubmitting(null)
    }
  }
  return (
    <MobileNativeChatPromptCardFrame
      testID="native-chat-approval-card"
      icon={ShieldQuestion}
      title={permission.title}
      titleTestID="native-chat-approval-title"
      headerAction={
        <MobileNativeChatCardHeaderAction
          prompt={permission.prompt}
          onCancel={onCancel}
          onCollapse={onCollapse}
          disabled={submitting !== null}
        />
      }
    >
      <MobileNativeChatPermissionContext permission={permission} newerSubject={newerSubject} />
      <View testID="native-chat-approval-actions" style={styles.options}>
        {permission.options.map((option, index) => (
          <Button
            key={`${option.send}:${option.label}`}
            label={option.label}
            variant={index === 0 ? 'primary' : 'secondary'}
            size="compact"
            busy={submitting === option.send}
            disabled={(submitting !== null && submitting !== option.send) || newerSubject}
            onPress={() => void respond(option.send)}
          />
        ))}
      </View>
    </MobileNativeChatPromptCardFrame>
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
          <Text style={styles.contextLabel}>Reason: </Text>
          {permission.decisionReason}
        </Text>
      ) : null}
      {neededPath ? (
        <Text style={styles.detail}>
          <Text style={styles.contextLabel}>Needs access to: </Text>
          {neededPath}
        </Text>
      ) : null}
      {isPlanApprovalSubject(permission.subject) ? (
        <View>
          <MobileMarkdown content={permission.subject.text} />
          {permission.subject.filePath ? (
            <Text style={styles.planFile}>Plan file: {permission.subject.filePath}</Text>
          ) : null}
        </View>
      ) : permission.detail ? (
        <Text style={styles.detail}>{permission.detail}</Text>
      ) : null}
      {newerSubject ? (
        <Text testID="native-chat-approval-needs-newer-orca" style={styles.detail}>
          This request needs a newer version of Orca.
        </Text>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  detail: promptCardStyles.detail,
  contextLabel: promptCardStyles.detailLabel,
  planFile: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 18
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
    columnGap: spacing.sm,
    flexShrink: 0
  }
})
