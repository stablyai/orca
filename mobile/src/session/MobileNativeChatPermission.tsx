import { memo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ShieldQuestion, X } from 'lucide-react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { MobileChatPermission } from './mobile-native-chat-permission'

// Renders a detected agent permission ask as a card with tappable options.
// The first option is treated as the primary (allow) action and gets a filled
// accent button so the affirmative choice reads as distinct from the rest.
function MobileNativeChatPermissionImpl({
  permission,
  onRespond,
  onCancel
}: {
  permission: MobileChatPermission
  onRespond: (send: string) => Promise<boolean>
  onCancel?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const hasContext = Boolean(
    permission.description ||
    permission.decisionReason ||
    permission.blockedPath ||
    permission.matchedAskRule ||
    permission.subject ||
    permission.detail
  )
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
          {permission.title}
        </Text>
        {onCancel ? (
          <Pressable
            accessibilityLabel="Cancel"
            hitSlop={8}
            style={styles.cancel}
            onPress={() => void onCancel(permission.prompt)}
            disabled={submitting}
          >
            <X size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {hasContext ? (
        <ScrollView
          testID="native-chat-approval-content"
          style={styles.contentScroll}
          contentContainerStyle={styles.content}
          nestedScrollEnabled
        >
          {permission.description ? (
            <Text style={styles.detail}>{permission.description}</Text>
          ) : null}
          {permission.decisionReason ? (
            <Text style={styles.detail}>
              <Text style={styles.contextLabel}>Reason: </Text>
              {permission.decisionReason}
            </Text>
          ) : null}
          {permission.blockedPath ? (
            <Text style={styles.detail}>
              <Text style={styles.contextLabel}>Blocked path: </Text>
              {permission.blockedPath}
            </Text>
          ) : null}
          {permission.matchedAskRule ? (
            <Text style={styles.detail}>
              <Text style={styles.contextLabel}>Ask rule: </Text>
              {permission.matchedAskRule.ruleContent ?? permission.matchedAskRule.toolName}
              {' · '}
              {permission.matchedAskRule.source}
            </Text>
          ) : null}
          {permission.subject?.kind === 'plan' ? (
            <View>
              <MobileMarkdown content={permission.subject.text} />
              {permission.subject.filePath ? (
                <Text style={styles.planFile}>Plan file: {permission.subject.filePath}</Text>
              ) : null}
            </View>
          ) : permission.detail ? (
            <Text style={styles.detail}>{permission.detail}</Text>
          ) : null}
        </ScrollView>
      ) : null}
      <View testID="native-chat-approval-actions" style={styles.options}>
        {permission.options.map((option, index) => {
          const isPrimary = index === 0
          return (
            <Pressable
              key={`${option.send}:${option.label}`}
              style={({ pressed }) => [
                styles.option,
                isPrimary ? styles.optionPrimary : styles.optionSecondary,
                pressed && !submitting && styles.optionPressed
              ]}
              hitSlop={6}
              onPress={() => respond(option.send)}
              disabled={submitting}
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

const styles = StyleSheet.create({
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
  cancel: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
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
  optionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionTextPrimary: {
    color: colors.onAccent
  }
})
