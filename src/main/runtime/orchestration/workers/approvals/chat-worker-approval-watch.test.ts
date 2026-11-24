import { afterEach, expect, it } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalResolution
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { readCrewApprovals } from '../../crew/crew-query'
import { escalateWorkerFailure } from '../reports/worker-failure-escalation'
import { ChatWorkerApprovalWatch } from './chat-worker-approval-watch'
import { workerApprovalPayload } from './worker-approval'
import { approvalReportId } from './worker-approval-report'

const SESSION = 'worker-chat-session'
const APPROVAL = 'claude-prompt:worker-chat-session:prompt-1'
let db: OrchestrationDb | undefined

afterEach(() => db?.close())

function approvalItem(resolution: AgentJournalResolution): AgentJournalApprovalItem {
  return {
    kind: 'approval',
    title: 'Allow Write?',
    toolName: 'Write',
    detail: '{"file_path":"/repo/.claude/skills/demo/SKILL.md"}',
    options: [
      { id: 'allow', label: 'Allow', intent: 'allow_once' },
      { id: 'deny', label: 'Deny', intent: 'reject_once' }
    ],
    resolution
  }
}

// Claude withdraws a worker's prompt when its PermissionRequest hook answers first, and the
// coordinator's card closes then; the chat records the allow only once the call has run.
it("names a withdrawn worker prompt allowed once the worker's chat records that its call ran", async () => {
  const orchestration = new OrchestrationDb(':memory:')
  db = orchestration
  const run = orchestration.createRun({
    objective: 'skills',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: null
  })
  const task = orchestration.createTask({ runId: run.id, spec: 'write the skill' })
  const dispatch = orchestration.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    creator: { kind: 'terminal', handle: 'term_coordinator' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  const pending = { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  escalateWorkerFailure(
    orchestration,
    dispatch,
    {
      id: approvalReportId(dispatch.id, APPROVAL, 'open'),
      from: 'term_worker',
      describe: () => ({ subject: 'Worker is waiting for permission', body: '' }),
      payload: {
        dispatchId: dispatch.id,
        handle: 'term_worker',
        approval: workerApprovalPayload({
          approvalId: APPROVAL,
          item: approvalItem({ ...pending, state: 'pending' }),
          worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: task.id }
        })
      }
    },
    () => {}
  )
  let item = approvalItem({ ...pending, state: 'cancelled' })
  const watch = new ChatWorkerApprovalWatch({
    getDb: () => orchestration,
    notify: () => {},
    signal: new AbortController().signal,
    setTimer: () => {},
    readPrompt: async () => ({ revision: 1, body: item }),
    watchJournal: () => () => {}
  })
  watch.track(SESSION, APPROVAL, dispatch.id)
  await watch.check(SESSION)
  item = approvalItem({
    state: 'resolved',
    selectedOptionId: 'allow',
    resolvedBy: 'trusted-local:agent-permission-flow',
    resolvedAt: 1_700_000_000_000
  })
  // The journal change that rewrote the item.
  await watch.check(SESSION)

  expect(
    readCrewApprovals(orchestration, [`run:${run.id}`]).map(({ approval }) => approval)
  ).toEqual([
    expect.objectContaining({
      state: 'answered',
      outcome: { by: 'worker-chat', decision: 'allow', reason: null, reasonDelivered: false }
    })
  ])
})
