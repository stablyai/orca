import { expect, it } from 'vitest'
import { subscribeWorkerApprovals } from './worker-approval-stream'
import type { CrewInvalidation } from './crew-changes'
import type {
  OrchestrationCrewRow,
  OrchestrationWorkerApprovalsFrame
} from '../../../../shared/orchestration/orchestration-crew'

const approval = {
  v: 1 as const,
  approvalId: 'apr_1',
  state: 'open' as const,
  worker: { handle: 'term_w', dispatchId: 'ctx_1', taskId: 'task_1' },
  summary: { title: 'Allow Bash?', detail: null, reason: null },
  allowedActions: ['allow' as const, 'deny' as const]
}

it("delivers a worker's prompt mailed to a Run the chat started coordinating after it subscribed", async () => {
  const runs = ['run:a']
  const mail = new Map<string, unknown[]>()
  const worker: OrchestrationCrewRow = {
    partyKey: 'w',
    role: 'worker',
    label: 'try-claude',
    agentKind: 'claude',
    status: 'blocked'
  }
  let wake: (facets: CrewInvalidation) => void = () => {}
  const frames: OrchestrationWorkerApprovalsFrame[] = []
  subscribeWorkerApprovals(
    {
      mailboxes: () => ['orca_session_id:chat', ...runs],
      approvals: (mailboxes) => mailboxes.flatMap((mailbox) => mail.get(mailbox) ?? []),
      workers: () => (mail.size ? [{ ...worker, approvals: [{ approval, at: 't1' }] }] : []),
      watch: (listener) => {
        wake = listener
        return () => {}
      }
    },
    (frame) => frames.push(frame)
  )
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  runs.push('run:b')
  wake(new Set(['topology']))
  await settle()
  mail.set('run:b', [approval])
  wake(Object.assign(new Set(['traffic'] as const), { trafficAddresses: new Set(['run:b']) }))
  await settle()

  expect(frames).toEqual([
    { type: 'begin' },
    { type: 'complete' },
    { type: 'begin' },
    { type: 'approval', entry: { approval, at: 't1', worker } },
    { type: 'complete' }
  ])
})
