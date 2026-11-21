import { expect, it } from 'vitest'
import { readCodexAutoReviewDenialFrame } from '../../../../shared/agent-session/requests/approvals/codex-auto-review-denial'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

it('keeps Approve once on a Codex denial larger than the provider frame limit', () => {
  const command = `psql -c "${'UPDATE accounts SET plan = 1; '.repeat(1000)}"`
  const row = unhandledProviderFrameJournalItem(
    'codex',
    'notification:item/autoApprovalReview/completed',
    {
      threadId: 'thread-1',
      turnId: 'turn-1',
      reviewId: 'review-1',
      startedAtMs: 1,
      review: { status: 'denied', rationale: 'Untrusted authorization' },
      action: { type: 'command', command, cwd: '/repo', source: 'shell' }
    }
  )
  const frame = row?.body.kind === 'status' ? row.body.providerFrame : undefined
  expect(readCodexAutoReviewDenialFrame(frame)?.event).toMatchObject({
    id: 'review-1',
    turn_id: 'turn-1',
    status: 'denied',
    action: { type: 'command', command, cwd: '/repo', source: 'shell' }
  })
})
