import { useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Timer } from '../../../../components/icons/app-icons'
import { workerApprovalTimeLeft } from '../../../../../../src/shared/orchestration/approvals/worker-approval-time-left'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { MobileAgentMessageOpenContext } from '../../transcript/agent-messages/mobile-agent-message-context'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import type { MobileWorkerApprovals } from './use-mobile-worker-approvals'

const NO_OTHER = [false] as const

/** A coordinator's oldest open worker prompt, in the chat's own question card, while the chat has
 *  no prompt of its own, with how many wait behind it and Claude's countdown; folding it gives the
 *  composer back and leaves its line in the prompt strip. */
export function useMobileNativeChatWorkerApprovalSlot(
  approvals: MobileWorkerApprovals | undefined,
  chatHasPrompt: boolean
): { card: React.JSX.Element | null; strip: MobileNativeChatCollapsedPrompt | null } {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState<string | null>(null)
  // The chat's own sender opener, as an agent message's name opens its sender.
  const openSender = useContext(MobileAgentMessageOpenContext)
  const entry = chatHasPrompt ? undefined : approvals?.open[0]
  if (!approvals || !entry) {
    return { card: null, strip: null }
  }
  const { approvalId, allowedActions, summary } = entry.approval
  const title = t('chat.workerApproval.title', '{{worker}} · {{title}}', {
    worker: entry.worker.label,
    title: summary.title
  })
  if (folded === approvalId) {
    return { card: null, strip: { title, expand: () => setFolded(null) } }
  }
  // The whole input: the person allows exactly what runs.
  const detail = summary.detail
  const fold = (): void => setFolded(approvalId)
  // Workers, not prompts: one worker's helpers can each ask at once.
  const waiting = new Set(approvals.open.map((open) => open.worker.partyKey)).size
  const { expiresAt } = entry.approval
  // Addressed by its Dispatch, as the desktop's Open worker finds it on its host.
  const worker = {
    party: {
      address: `dispatch:${entry.approval.worker.dispatchId}`,
      terminalHandle: null,
      orcaSessionId: null
    },
    name: entry.worker.label
  }
  const openWorker = openSender
    ? () => openSender({ kind: 'agent', senders: [worker], orchestration: null }, worker)
    : null
  return {
    strip: null,
    card: (
      <MobileNativeChatAsk
        key={approvalId}
        prompt={{
          questions: [
            {
              question: detail ? `${title}\n\n${detailMarkdown(detail)}` : title,
              multiSelect: false,
              options: allowedActions.map((decision) => ({
                label:
                  decision === 'allow'
                    ? t('chat.workerApproval.allow', 'Allow')
                    : t('chat.workerApproval.deny', 'Deny')
              }))
            }
          ]
        }}
        allowOther={NO_OTHER}
        choiceOnly
        note={
          <View>
            {waiting > 1 || openWorker ? (
              <View style={[styles.queue, styles.noteLine]}>
                <Text style={styles.noteText}>
                  {waiting > 1
                    ? t('chat.workerApproval.waiting', '{{count}} workers waiting · oldest first', {
                        count: waiting
                      })
                    : ''}
                </Text>
                {openWorker ? (
                  <Pressable
                    onPress={openWorker}
                    hitSlop={8}
                    accessibilityRole="button"
                    style={({ pressed }) => (pressed ? pressedStyle : null)}
                  >
                    <Text style={styles.open}>
                      {t('chat.workerApproval.openWorker', 'Open worker')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {expiresAt ? <WorkerApprovalCountdown expiresAt={expiresAt} /> : null}
          </View>
        }
        onAnswer={async ([selection]) => {
          const decision = allowedActions[selection?.indices[0] ?? -1]
          return decision ? approvals.answer(entry, decision) : false
        }}
        onCollapse={fold}
      />
    )
  }
}

/** Claude's own deadline, ticking each second here alone; gone once it passes. */
function WorkerApprovalCountdown({ expiresAt }: { expiresAt: string }) {
  const t = useMobileTranslation()
  const timeLeft = workerApprovalTimeLeft(expiresAt, useNow(1_000))
  return timeLeft ? (
    <View style={[styles.countdown, styles.noteLine]}>
      <Timer size={14} strokeWidth={2.2} color={colors.agentQuestion} />
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

// One line reads as inline code, as the chat shows a command; longer input keeps its lines.
function detailMarkdown(detail: string): string {
  if (!detail.includes('\n') && !detail.includes('`')) {
    return `\`${detail}\``
  }
  // Longer than any backtick run inside, so the input can't close its own block early.
  const longest = Math.max(0, ...(detail.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${detail}\n${fence}`
}

const styles = themedStyleSheet(() => ({
  // On each line, so a countdown that ran out leaves no gap.
  noteLine: { marginTop: spacing.xs, marginBottom: spacing.xs },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  queue: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  open: { fontSize: typography.metaSize, fontWeight: '600', color: colors.textPrimary },
  noteText: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
}))
