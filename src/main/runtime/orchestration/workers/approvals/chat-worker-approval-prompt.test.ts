import { expect, it } from 'vitest'
import { answerChatWorkerApproval } from './chat-worker-approval-prompt'

it("reports a person-only prompt the person already answered as closed, not as the person's to answer", async () => {
  const answered = await answerChatWorkerApproval({
    sessionId: 'session-1',
    approvalId: 'item_1',
    dispatchId: 'ctx_1',
    decision: 'allow',
    byAgent: true,
    readPrompt: async () => ({
      revision: 2,
      body: {
        kind: 'approval',
        title: 'Allow Bash?',
        detail: 'rm -rf build',
        personOnly: true,
        options: [
          { id: 'allow', label: 'Allow', intent: 'allow_once' },
          { id: 'deny', label: 'Deny', intent: 'reject_once' }
        ],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: 'desktop-renderer',
          resolvedAt: 2
        }
      }
    })
  })

  expect(answered).toMatchObject({ ok: false, code: 'approval_not_open' })
})
