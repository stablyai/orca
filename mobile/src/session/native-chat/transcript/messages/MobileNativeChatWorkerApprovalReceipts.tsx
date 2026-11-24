// A coordinator chat's closed worker prompts, each one status line after the message before it was
// asked, in the desktop's words (NativeChatWorkerApprovalReceipt): shield, sentence, time; the
// command and any coordinator reason open under it.
import { createContext, memo, useContext, useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  ArrowUpRight,
  ShieldCheck,
  ShieldMinus,
  ShieldQuestion,
  ShieldX
} from 'lucide-react-native'
import { anchorNativeChatTimedRows } from '../../../../../../src/shared/native-chat/transcript/native-chat-timed-row-anchors'
import {
  workerApprovalRecord,
  type WorkerApprovalRecordSentence,
  type WorkerApprovalRecordTone
} from '../../../../../../src/shared/orchestration/approvals/worker-approval-record'
import { readShellApprovalDetail } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-shell-detail'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { MobileAgentMessageOpenContext } from '../agent-messages/mobile-agent-message-context'
import { workerOpener } from '../../input/prompts/MobileNativeChatWorkerApproval'
import type { MobileWorkerApproval } from '../../input/prompts/use-mobile-worker-approvals'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'
import { MONO_SIZE, scaledType, styles as rowStyles } from './mobile-native-chat-message-styles'

type Placed = ReadonlyMap<string, readonly MobileWorkerApproval[]>

/** Keyed by message id: the closed worker prompts drawn after that message, oldest first. */
export const MobileWorkerApprovalReceiptsContext = createContext<Placed | null>(null)

const SEP = '\u0000'

/** Stable while no receipt changes the message it follows, so streaming text redraws none. */
export function useMobileWorkerApprovalReceiptPlacement(
  shown: {
    listMessages: readonly NativeChatMessage[]
    waitingRows: readonly { item: NativeChatMessage }[]
  },
  receipts: readonly MobileWorkerApproval[] | undefined
): Placed | null {
  const anchors = receipts?.length
    ? anchorNativeChatTimedRows(
        [...shown.listMessages, ...shown.waitingRows.map(({ item }) => item)].flatMap((row) =>
          row.timestamp === null ? [] : [{ id: row.id, at: row.timestamp }]
        ),
        receipts.map((entry) => ({
          key: entry.approval.approvalId,
          at: Date.parse(entry.askedAt ?? entry.at)
        }))
      )
        // A conversation with no dated message has nowhere to place one.
        .flatMap(([key, messageId]) => (messageId ? [`${key}${SEP}${messageId}`] : []))
        .join(SEP + SEP)
    : ''
  return useMemo(() => {
    if (!anchors || !receipts) {
      return null
    }
    const byId = new Map(receipts.map((entry) => [entry.approval.approvalId, entry]))
    const placed = new Map<string, MobileWorkerApproval[]>()
    for (const pair of anchors.split(SEP + SEP)) {
      const [key = '', messageId = ''] = pair.split(SEP)
      const entry = byId.get(key)
      if (entry) {
        placed.set(messageId, [...(placed.get(messageId) ?? []), entry])
      }
    }
    return placed
  }, [anchors, receipts])
}

/** The receipts placed after this message, if any; a streamed update to the row redraws none. */
export const MobileNativeChatWorkerApprovalReceipts = memo(
  function MobileNativeChatWorkerApprovalReceipts({
    messageId,
    fontScale
  }: {
    messageId: string
    fontScale: number
  }): React.JSX.Element | null {
    const entries = useContext(MobileWorkerApprovalReceiptsContext)?.get(messageId)
    return entries ? (
      <View style={[rowStyles.row, styles.lines]}>
        {entries.map((entry) => (
          <WorkerApprovalReceipt
            key={entry.approval.approvalId}
            entry={entry}
            fontScale={fontScale}
          />
        ))}
      </View>
    ) : null
  }
)

const TONE_ICON: Record<WorkerApprovalRecordTone, typeof ShieldCheck> = {
  allowed: ShieldCheck,
  denied: ShieldX,
  open: ShieldQuestion,
  closed: ShieldMinus
}

function WorkerApprovalReceipt({
  entry,
  fontScale
}: {
  entry: MobileWorkerApproval
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openWorker = workerOpener(useContext(MobileAgentMessageOpenContext), entry)
  const { approval } = entry
  const record = workerApprovalRecord(approval)
  const Icon = TONE_ICON[record.tone]
  const values = { tool: record.tool, task: entry.worker.label }
  const parts = sentenceParts(recordSentence(t, record.sentence), values)
  const { detail, tool } = approval.summary
  const command = detail
    ? (readShellApprovalDetail(detail, tool, undefined)?.command ?? detail)
    : null
  const text = scaledType(typography.metaSize, fontScale)
  const details =
    command || record.reason ? (
      <>
        {record.reason ? (
          <Text selectable style={[styles.detail, text]}>
            <Text style={styles.label}>
              {record.reason.sentAsMessage
                ? t('chat.workerApproval.record.reasonSentAsMessage', 'Reason, sent as a message')
                : t('chat.workerApproval.record.coordinatorReason', "Coordinator's reason")}
              {': '}
            </Text>
            {record.reason.text}
          </Text>
        ) : null}
        {command ? (
          <Text selectable style={[styles.detail, styles.code, scaledType(MONO_SIZE, fontScale)]}>
            {command}
          </Text>
        ) : null}
      </>
    ) : null
  return (
    <MobileNativeChatEventRow
      testID={`worker-approval-receipt:${approval.approvalId}`}
      icon={<Icon size={14} color={colors.textMuted} strokeWidth={2} />}
      label={parts.map((part) => part.text).join('')}
      action={
        openWorker ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.workerApproval.openWorker', 'Open worker')}
            hitSlop={12}
            onPress={openWorker}
            style={({ pressed }) => pressed && pressedStyle}
          >
            <ArrowUpRight size={14} color={colors.textMuted} />
          </Pressable>
        ) : null
      }
      timestamp={Date.parse(entry.at)}
      details={details}
      disclosureKey={`worker-approval:${approval.approvalId}`}
      fontScale={fontScale}
      wordsLines={2}
    >
      {parts.map((part) =>
        part.name ? (
          <MobileNativeChatEventName key={part.name}>{part.text}</MobileNativeChatEventName>
        ) : (
          part.text
        )
      )}
    </MobileNativeChatEventRow>
  )
}

/** The sentence split at its `<tool>`/`<task>` marks, filled after the split so a name can't add one. */
function sentenceParts(
  sentence: string,
  values: { tool: string; task: string }
): { text: string; name: string | null }[] {
  const fill = (part: string) =>
    part.replaceAll(KEEP.tool, () => values.tool).replaceAll(KEEP.task, () => values.task)
  return sentence
    .split(/(<tool>.*?<\/tool>|<task>.*?<\/task>)/)
    .filter(Boolean)
    .map((part) => {
      const named = /^<(tool|task)>(.*)<\/\1>$/.exec(part)
      return { text: fill(named ? named[2]! : part), name: named ? named[1]! : null }
    })
}

// Stand-ins no translation holds: sentenceParts swaps in the names after the split.
const KEEP = { tool: '\u0001', task: '\u0002' }

function recordSentence(t: Translate, sentence: WorkerApprovalRecordSentence): string {
  switch (sentence) {
    case 'youAllowedFor':
      return t(
        'chat.workerApproval.record.youAllowedFor',
        'You allowed <tool>{{tool}}</tool> for <task>{{task}}</task>',
        KEEP
      )
    case 'youDeniedFor':
      return t(
        'chat.workerApproval.record.youDeniedFor',
        'You denied <tool>{{tool}}</tool> for <task>{{task}}</task>',
        KEEP
      )
    case 'coordinatorAllowed':
      return t(
        'chat.workerApproval.record.coordinatorAllowed',
        'Coordinator allowed <tool>{{tool}}</tool> for <task>{{task}}</task>',
        KEEP
      )
    case 'coordinatorDenied':
      return t(
        'chat.workerApproval.record.coordinatorDenied',
        'Coordinator denied <tool>{{tool}}</tool> for <task>{{task}}</task>',
        KEEP
      )
    case 'allowedInTerminal':
      return t(
        'chat.workerApproval.record.allowedInTerminal',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its terminal',
        KEEP
      )
    case 'deniedInTerminal':
      return t(
        'chat.workerApproval.record.deniedInTerminal',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its terminal',
        KEEP
      )
    case 'allowedInChat':
      return t(
        'chat.workerApproval.record.allowedInChat',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> allowed in its chat',
        KEEP
      )
    case 'deniedInChat':
      return t(
        'chat.workerApproval.record.deniedInChat',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> denied in its chat',
        KEEP
      )
    case 'autoDenied':
      return t(
        'chat.workerApproval.record.autoDenied',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> denied automatically after 2:00',
        KEEP
      )
    case 'waitsInTerminal':
      return t(
        'chat.workerApproval.record.waitsInTerminal',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> waits in its terminal',
        KEEP
      )
    case 'workerEnded':
      return t(
        'chat.workerApproval.record.workerEnded',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> closed: the worker ended',
        KEEP
      )
    case 'closedUnnamed':
      return t(
        'chat.workerApproval.record.closedUnnamed',
        '<tool>{{tool}}</tool> for <task>{{task}}</task> closed without a recorded answer',
        KEEP
      )
  }
}

const styles = themedStyleSheet(() => ({
  lines: { gap: spacing.sm },
  detail: { color: colors.textSecondary },
  label: { fontWeight: '600' },
  code: { fontFamily: typography.monoFamily }
}))
