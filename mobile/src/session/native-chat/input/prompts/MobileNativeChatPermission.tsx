import { memo, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronDown, ShieldQuestion } from 'lucide-react-native'
import { approvalDetailPreview } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-detail-preview'
import { approvalBlockedPathToShow } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-blocked-path'
import { readShellApprovalDetail } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-shell-detail'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'
import { useMobilePendingControl } from '../../../../components/controls/use-mobile-pending-control'
import { MobileNativeChatMarkdown } from '../../transcript/message-content/MobileNativeChatMarkdown'
import { stylesSheet as markdownStylesSheet } from '../../../../components/markdown/mobile-markdown-styles'
import {
  pressedStyle,
  spacing,
  typography,
  type MobileColorScheme
} from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject,
  isUrlApprovalSubject,
  URL_APPROVAL_DECLINE_OPTION_ID,
  URL_APPROVAL_OPEN_OPTION_ID
} from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-subject'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import {
  canOpenUrlRequestPage,
  MobileNativeChatUrlTarget,
  openUrlRequestPage
} from './MobileNativeChatUrlRequest'
import { structuredApprovalOptionId } from './mobile-structured-agent-prompts'
import { ASK_CHOICE_RADIUS, mobileNativeChatAskStylesSheet } from './MobileNativeChatAsk.styles'

// Option sends are keyed by their payload; the header's cancel by a key no payload can take.
const CANCEL = '\0cancel'

/** Every approval on the phone (the agent's own, a worker's, a paired server's): the ask card's
 *  shell, the request in the chat's code style, and the answers stacked under it. */
function MobileNativeChatPermissionImpl({
  permission,
  onRespond,
  onCancel,
  onCollapse,
  onAnswerInTerminal,
  note,
  onOpenWorker,
  notice
}: {
  permission: MobileChatPermission
  onRespond: (send: string) => Promise<boolean>
  /** Shown when the card has no options: only the terminal can answer it. */
  onAnswerInTerminal?: () => void
  onCancel?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
  /** Under the request: what the card's owner adds, e.g. a worker prompt's countdown. */
  note?: ReactNode
  /** Opens the worker that asked, from the card's details. */
  onOpenWorker?: () => void
  /** Why the last answer didn't go. */
  notice?: string | null
}): React.JSX.Element {
  const askStyles = useThemedStyles(mobileNativeChatAskStylesSheet)
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  // An accepted answer keeps the card locked until the host retires it (the card remounts).
  const { pending, run } = useMobilePendingControl<string>({ holdAccepted: true })
  const submitting = pending !== null
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
  return (
    <View testID="native-chat-approval-card" style={askStyles.card}>
      <ScrollView style={askStyles.scroll} nestedScrollEnabled>
        <View style={askStyles.questionRow}>
          <ShieldQuestion
            size={ICON_SIZE}
            color={colors.textSecondary}
            strokeWidth={2}
            style={styles.icon}
          />
          {/* Plain text, sized as the ask card's question: a tool or server name is never markup. */}
          <Text style={[askStyles.questionText, styles.title]}>{title}</Text>
          <MobileNativeChatCardHeaderAction
            prompt={permission.prompt}
            onCancel={onCancel && (() => run(CANCEL, () => onCancel(permission.prompt)))}
            onCollapse={onCollapse}
            disabled={submitting}
            cancelPending={pending === CANCEL}
          />
        </View>
        <MobileNativeChatPermissionContext
          permission={permission}
          newerSubject={newerSubject}
          onOpenWorker={onOpenWorker}
          note={note}
        />
      </ScrollView>
      {/* Its own scroll, so a request with many choices still reaches the last. */}
      <ScrollView
        testID="native-chat-approval-actions"
        style={styles.answersScroll}
        contentContainerStyle={styles.answers}
        nestedScrollEnabled
      >
        {notice ? (
          <Text style={styles.notice} accessibilityRole="alert">
            {notice}
          </Text>
        ) : null}
        {permission.options.map((option, index) => {
          const isPrimary = index === 0 && !permission.neutralOptions
          const opensUrl =
            url !== null && structuredApprovalOptionId(option.send) === URL_APPROVAL_OPEN_OPTION_ID
          const unopenable = opensUrl && !canOpenUrlRequestPage(url)
          return (
            <MobilePendingButton
              key={`${option.send}:${option.label}`}
              label={optionLabel(option)}
              numberOfLines={0}
              style={[askStyles.next, styles.answer, !isPrimary && askStyles.nextSkip]}
              labelStyle={[
                askStyles.nextText,
                styles.answerText,
                !isPrimary && askStyles.nextSkipText,
                option.declines && styles.declineText
              ]}
              spinnerColor={isPrimary ? colors.bgBase : colors.textPrimary}
              pending={pending === option.send}
              disabled={submitting || newerSubject || unopenable}
              onPress={() =>
                void run(option.send, () => {
                  // Opened only by the press the send admits, still inside the tap.
                  if (opensUrl) {
                    openUrlRequestPage(url)
                  }
                  return onRespond(option.send)
                })
              }
            />
          )
        })}
        {permission.options.length === 0 && onAnswerInTerminal ? (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [askStyles.next, styles.answer, pressed && pressedStyle]}
            onPress={onAnswerInTerminal}
          >
            <Text style={[askStyles.nextText, styles.answerText]}>
              {t('chat.promptCard.answerInTerminal', 'Answer in terminal')}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  )
}

export const MobileNativeChatPermission = memo(MobileNativeChatPermissionImpl)

function MobileNativeChatPermissionContext({
  permission,
  newerSubject,
  onOpenWorker,
  note
}: {
  permission: MobileChatPermission
  newerSubject: boolean
  onOpenWorker?: () => void
  note?: ReactNode
}): React.JSX.Element | null {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const neededPath = approvalBlockedPathToShow(permission)
  if (
    !permission.description &&
    !permission.decisionReason &&
    !neededPath &&
    !permission.subject &&
    !permission.detail &&
    !onOpenWorker &&
    !note
  ) {
    return null
  }
  return (
    <View testID="native-chat-approval-content" style={styles.content}>
      {permission.description ? <Text style={styles.line}>{permission.description}</Text> : null}
      {permission.decisionReason ? (
        <Text style={styles.line}>
          <Text style={styles.lineLabel}>{t('chat.permission.reason', 'Reason: ')}</Text>
          {permission.decisionReason}
        </Text>
      ) : null}
      {neededPath ? (
        <Text style={styles.line}>
          <Text style={styles.lineLabel}>
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
      ) : permission.detail || onOpenWorker ? (
        <MobileNativeChatPermissionDetail
          detail={permission.detail}
          toolName={permission.toolName}
          description={permission.description}
          onOpenWorker={onOpenWorker}
          note={note}
        />
      ) : (
        note
      )}
      {newerSubject ? (
        <Text testID="native-chat-approval-needs-newer-orca" style={styles.line}>
          {t('chat.permission.newerVersionRequired', 'This request needs a newer version of Orca.')}
        </Text>
      ) : null}
    </View>
  )
}

/** The request as the chat shows code; the rest of its input and the worker link wait behind Details. */
function MobileNativeChatPermissionDetail({
  detail,
  toolName,
  description,
  onOpenWorker,
  note
}: {
  detail: string | undefined
  toolName: string | undefined
  description: string | undefined
  onOpenWorker?: () => void
  note?: ReactNode
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const shell = detail ? readShellApprovalDetail(detail, toolName, description) : null
  const text = shell?.command ?? detail
  const preview = text ? approvalDetailPreview(text) : undefined
  // Allow grants the sandbox opt-out too, so it never waits behind Details (the reader writes it first).
  const unsandboxed =
    shell?.otherArguments?.startsWith('{"dangerouslyDisableSandbox":true') === true
  const otherArguments = expanded || unsandboxed ? shell?.otherArguments : null
  const hasMore =
    preview !== text || (Boolean(shell?.otherArguments) && !unsandboxed) || Boolean(onOpenWorker)
  return (
    <>
      {text ? (
        <View style={styles.codeBox}>
          <Text selectable style={styles.code}>
            {expanded ? text : preview}
          </Text>
        </View>
      ) : null}
      {otherArguments ? (
        <Text selectable style={styles.otherArguments}>
          {otherArguments}
        </Text>
      ) : null}
      {note}
      {hasMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          hitSlop={8}
          style={({ pressed }) => [styles.detailsRow, pressed && pressedStyle]}
        >
          <Text style={styles.detailsText}>
            {expanded ? t('common.hideDetails', 'Hide details') : t('common.details', 'Details')}
          </Text>
          <ChevronDown
            size={14}
            color={colors.textSecondary}
            style={expanded ? styles.chevronOpen : undefined}
          />
        </Pressable>
      ) : null}
      {expanded && onOpenWorker ? (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenWorker}
          hitSlop={8}
          style={({ pressed }) => [styles.detailsRow, pressed && pressedStyle]}
        >
          <Text style={styles.openWorker}>
            {t('chat.workerApproval.openWorker', 'Open worker')}
          </Text>
        </Pressable>
      ) : null}
    </>
  )
}

const ICON_SIZE = 16

function markdownLineHeight(scheme: MobileColorScheme): number {
  const { paragraph } = markdownStylesSheet.resolve(scheme)
  return (paragraph.lineHeight * typography.bodySize) / paragraph.fontSize
}

const stylesSheet = themedStyleSheet((colors, scheme) => ({
  // Centred on the title's first line, as the question text sits in its row.
  icon: { marginTop: 13 },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: markdownLineHeight(scheme),
    fontWeight: '500'
  },
  content: { gap: 6, marginBottom: 6 },
  line: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  lineLabel: { color: colors.textPrimary, fontWeight: '600' },
  codeBox: {
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: ASK_CHOICE_RADIUS,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  code: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17
  },
  otherArguments: {
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17
  },
  planFile: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  detailsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    alignSelf: 'flex-start'
  },
  detailsText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  openWorker: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  answersScroll: { flexGrow: 0, flexShrink: 1 },
  answers: {
    gap: 6,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md
  },
  answer: { alignItems: 'center' },
  answerText: { textAlign: 'center' },
  declineText: { color: colors.statusRed },
  notice: { color: colors.statusRed, fontSize: typography.metaSize, lineHeight: 17 }
}))
