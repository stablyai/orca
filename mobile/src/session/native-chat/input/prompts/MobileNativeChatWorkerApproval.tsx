import { useState } from 'react'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { MobileNativeChatCollapsedPrompt } from './MobileNativeChatPromptStrip'
import type { MobileWorkerApprovals } from './use-mobile-worker-approvals'

const NO_OTHER = [false] as const

/** A coordinator's oldest open worker prompt, in the chat's own question card, while the chat has
 *  no prompt of its own; folding it gives the composer back and leaves its line in the prompt strip. */
export function useMobileNativeChatWorkerApprovalSlot(
  approvals: MobileWorkerApprovals | undefined,
  chatHasPrompt: boolean
): { card: React.JSX.Element | null; strip: MobileNativeChatCollapsedPrompt | null } {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState<string | null>(null)
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
        onAnswer={async ([selection]) => {
          const decision = allowedActions[selection?.indices[0] ?? -1]
          return decision ? approvals.answer(entry, decision) : false
        }}
        onCollapse={fold}
      />
    )
  }
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
