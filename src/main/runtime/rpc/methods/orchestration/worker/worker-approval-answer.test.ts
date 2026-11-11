import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentJournalApprovalItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { approvalReportId } from '../../../../orchestration/workers/approvals/worker-approval-report'
import type { ChatWorkerPrompt } from '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'

const chat = vi.hoisted(() => {
  const state: {
    custody: 'chat' | 'terminal' | 'unverifiable'
    answer: ReturnType<typeof vi.fn>
    prompt: ChatWorkerPrompt | null
  } = { custody: 'chat', answer: vi.fn(), prompt: null }
  return state
})

vi.mock('../../../../orchestration/mailbox/routing/structured-session-mail-target', () => ({
  structuredMailboxCustody: () =>
    chat.custody === 'chat'
      ? { sessionId: 'session-1', dispatchId: null }
      : chat.custody === 'terminal'
        ? 'elsewhere'
        : 'unverifiable'
}))
vi.mock(
  '../../../../orchestration/workers/approvals/chat-worker-approval-prompt',
  async (actual) => ({
    ...(await actual<object>()),
    answerChatWorkerApproval: chat.answer,
    readChatWorkerPrompt: async () => chat.prompt
  })
)

const { answerWorkerApproval } = await import('./worker-approval-answer')

const HANDLE = 'term_worker'

function item(resolvedBy: string | null): AgentJournalApprovalItem {
  return {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: 'rm -rf build',
    options: [
      { id: 'allow', label: 'Allow', intent: 'allow_once' },
      { id: 'deny', label: 'Deny', intent: 'reject_once' }
    ],
    resolution: resolvedBy
      ? { state: 'resolved', selectedOptionId: 'allow', resolvedBy, resolvedAt: 2 }
      : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

function setup(approvalId: string) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, HANDLE)
  // The escalation Orca's stop report stored for this approval.
  db.insertMessage({
    id: approvalReportId(dispatch.id, approvalId, 'open'),
    from: HANDLE,
    to: `run:${run.id}`,
    subject: 'Worker is waiting for permission',
    type: 'escalation',
    payload: JSON.stringify({
      approval: {
        v: 1,
        approvalId,
        state: 'open',
        worker: { handle: HANDLE, dispatchId: dispatch.id, taskId: dispatch.task_id },
        summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
        allowedActions: ['allow', 'deny']
      }
    }),
    runId: run.id
  })
  const terminalAnswer = vi.fn(async () => ({
    ok: false as const,
    code: 'approval_not_open' as const,
    message: 'gone'
  }))
  const runtime = {
    getOrchestrationDb: () => db,
    notifyMessageArrived: vi.fn(),
    terminalWorkerApprovals: { answer: terminalAnswer, isHeld: () => false }
  }
  const call = (decision: 'allow' | 'deny', access: Parameters<typeof answerWorkerApproval>[2]) =>
    answerWorkerApproval(
      { dispatch: dispatch.id, prompt: approvalId, decision },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
      { runtime: runtime as never },
      access
    )
  const closings = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.subject.startsWith('Worker approval '))
      .map((message) => message.body)
  const mailToWorker = () =>
    z
      .object({ body: z.string() })
      .array()
      .parse(
        db.db
          .prepare(`SELECT body FROM messages WHERE to_handle = ?`)
          .all(`dispatch:${dispatch.id}`)
      )
  return { call, closings, mailToWorker }
}

const person = { answeredBy: 'person' as const, reason: 'Denied by the owner.' }
const coordinator = { answeredBy: 'coordinator' as const, reason: 'Use a script file.' }

describe('answering a worker approval', () => {
  it("closes a chat worker's card at once when its own chat already answered it", async () => {
    chat.custody = 'chat'
    chat.answer.mockResolvedValue({ ok: false, code: 'approval_not_open', message: 'gone' })
    chat.prompt = { revision: 2, body: item('desktop-renderer') }
    const ctx = setup('item_1')

    await expect(ctx.call('allow', person)).rejects.toMatchObject({ code: 'approval_not_open' })
    await expect(ctx.call('allow', person)).rejects.toMatchObject({ code: 'approval_not_open' })
    expect(ctx.closings()).toEqual([
      expect.stringContaining("Allowed in the worker's own chat: approval item_1")
    ])
  })

  it("mails a deny reason to a chat worker only when it is the coordinator's", async () => {
    chat.custody = 'chat'
    chat.answer.mockResolvedValue({
      ok: true,
      prompt: { revision: 2, body: item('trusted-local:orchestration:approval:x') },
      optionLabel: 'Deny'
    })
    const byPerson = setup('item_1')
    await byPerson.call('deny', person)
    expect(byPerson.mailToWorker()).toEqual([])

    const byCoordinator = setup('item_1')
    await byCoordinator.call('deny', coordinator)
    expect(byCoordinator.mailToWorker()).toEqual([{ body: 'Use a script file.' }])
  })

  it("refuses, and leaves the card open, when Orca can't tell what kind of worker it is", async () => {
    chat.custody = 'unverifiable'
    const ctx = setup('item_1')

    await expect(ctx.call('deny', coordinator)).rejects.toMatchObject({ code: 'approval_refused' })
    expect(ctx.closings()).toEqual([])
  })

  it('closes a terminal prompt Orca no longer holds, so its card stops offering answers', async () => {
    chat.custody = 'terminal'
    const ctx = setup('apr_1')

    await expect(ctx.call('deny', coordinator)).rejects.toMatchObject({
      code: 'approval_not_open'
    })
    expect(ctx.closings()).toEqual([
      expect.stringContaining('Closed without an answer Orca can name: approval apr_1')
    ])
  })
})
