import { useContext, useState } from 'react'
import { Text, View } from 'react-native'
import { Timer } from 'lucide-react-native'
import { approvalRecordTool } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-tool'
import { workerApprovalTimeLeft } from '../../../../../../src/shared/orchestration/approvals/worker-approval-time-left'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { MobileAgentMessageOpenContext } from '../../transcript/agent-messages/mobile-agent-message-context'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import type { MobileWorkerApproval, MobileWorkerApprovals } from './use-mobile-worker-approvals'
import { pairedServerAskSlot } from './MobilePairedServerAsk'

/** A coordinator's oldest open worker prompt, on the chat's approval card, while the chat has no
 *  prompt of its own, with how many wait behind it and Claude's countdown; folding it gives the
 *  composer back and leaves its line in the prompt strip. */
export function useMobileNativeChatWorkerApprovalSlot(
  approvals: MobileWorkerApprovals | undefined,
  chatHasPrompt: boolean,
  notice?: string | null
): { card: React.JSX.Element | null; strip: MobileNativeChatCollapsedPrompt | null } {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState<string | null>(null)
  // The chat's own sender opener, as an agent message's name opens its sender.
  const openSender = useContext(MobileAgentMessageOpenContext)
  const entry = chatHasPrompt ? undefined : approvals?.open[0]
  const pairedCard = chatHasPrompt || entry ? undefined : approvals?.pairedServerAsks?.open[0]
  if (approvals?.pairedServerAsks && pairedCard) {
    return pairedServerAskSlot(approvals.pairedServerAsks, pairedCard, folded, setFolded, t, notice)
  }
  if (!approvals || !entry) {
    return { card: null, strip: null }
  }
  const { approvalId, allowedActions, summary } = entry.approval
  const tool = approvalRecordTool(summary.tool, summary.title)
  // Without a named tool the title is the agent's own sentence ("Run a command?").
  const title = summary.tool
    ? t('chat.workerApproval.allowFor', 'Allow {{tool}} for {{worker}}?', {
        tool,
        worker: entry.worker.label
      })
    : t('chat.workerApproval.title', '{{worker}} · {{title}}', {
        worker: entry.worker.label,
        title: summary.title
      })
  if (folded === approvalId) {
    return { card: null, strip: { title, expand: () => setFolded(null) } }
  }
  // Workers, not prompts: one worker's helpers can each ask at once.
  const waiting = new Set(approvals.open.map((open) => open.worker.partyKey)).size
  const { expiresAt } = entry.approval
  return {
    strip: null,
    card: (
      <MobileNativeChatPermission
        key={approvalId}
        permission={{
          title,
          toolName: tool,
          ...(summary.reason ? { decisionReason: summary.reason } : {}),
          ...(summary.detail ? { detail: summary.detail } : {}),
          options: allowedActions.map((decision) =>
            decision === 'allow'
              ? { label: t('chat.workerApproval.allow', 'Allow'), send: decision }
              : { label: t('chat.workerApproval.deny', 'Deny'), send: decision, declines: true }
          )
        }}
        note={
          waiting > 1 || expiresAt ? (
            <View style={styles.notes}>
              {waiting > 1 ? (
                <Text style={styles.noteText}>
                  {t('chat.workerApproval.waiting', '{{count}} workers waiting · oldest first', {
                    count: waiting
                  })}
                </Text>
              ) : null}
              {expiresAt ? <WorkerApprovalCountdown expiresAt={expiresAt} /> : null}
            </View>
          ) : undefined
        }
        onOpenWorker={workerOpener(openSender, entry) ?? undefined}
        notice={notice}
        onRespond={async (send) => {
          const decision = allowedActions.find((action) => action === send)
          return decision ? approvals.answer(entry, decision) : false
        }}
        onCollapse={() => setFolded(approvalId)}
      />
    )
  }
}

/** Opens the worker that asked, through the chat's own sender opener. */
export function workerOpener(
  openSender: React.ContextType<typeof MobileAgentMessageOpenContext>,
  entry: MobileWorkerApproval
): (() => void) | null {
  return dispatchOpener(openSender, entry.approval.worker.dispatchId, entry.worker.label)
}

/** Opens a worker by its Dispatch, as the desktop's Open worker finds it on its host. */
export function dispatchOpener(
  openSender: React.ContextType<typeof MobileAgentMessageOpenContext>,
  dispatchId: string,
  name: string
): (() => void) | null {
  const worker = {
    party: { address: `dispatch:${dispatchId}`, terminalHandle: null, orcaSessionId: null },
    name
  }
  return openSender
    ? () => openSender({ kind: 'agent', senders: [worker], orchestration: null }, worker)
    : null
}

/** Claude's own deadline, ticking each second here alone; gone once it passes. */
function WorkerApprovalCountdown({ expiresAt }: { expiresAt: string }) {
  const t = useMobileTranslation()
  const timeLeft = workerApprovalTimeLeft(expiresAt, useNow(1_000))
  return timeLeft ? (
    <View style={styles.countdown}>
      <Timer size={14} strokeWidth={2.2} color={colors.textSecondary} />
      <Text style={styles.noteText}>
        {t(
          'chat.workerApproval.countdown',
          'Claude denies it on its own in {{time}} if nobody answers.',
          { time: timeLeft }
        )}
      </Text>
    </View>
  ) : null
}

const styles = themedStyleSheet(() => ({
  notes: { gap: spacing.xs },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  noteText: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
}))
