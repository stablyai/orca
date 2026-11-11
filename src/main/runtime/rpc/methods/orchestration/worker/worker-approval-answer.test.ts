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
import type * as ChatApprovalPrompt from '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'
import type { WorkerApprovalPayload } from '../../../../../../shared/orchestration/approvals/worker-approval-payload'

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
const { workerApprovalAccess } = await import('./worker-approval-access')
type ChatApprovalPromptModule = typeof ChatApprovalPrompt
const { answerChatWorkerApproval } = await vi.importActual<ChatApprovalPromptModule>(
  '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'
)

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

type TerminalAnswer =
  | { ok: true; approval: WorkerApprovalPayload }
  | { ok: false; code: 'approval_not_open' | 'approval_requires_person'; message: string }

function openPayload(
  approvalId: string,
  dispatchId: string,
  taskId: string
): WorkerApprovalPayload {
  return {
    v: 1,
    approvalId,
    state: 'open',
    worker: { handle: HANDLE, dispatchId, taskId },
    summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
    allowedActions: ['allow', 'deny']
  }
}

function setup(
  approvalId: string,
  options: {
    coordinatorApprovals?: boolean
    terminal?: (payload: WorkerApprovalPayload) => TerminalAnswer
  } = {}
) {
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
  const terminalAnswer = vi.fn(
    async (): Promise<TerminalAnswer> =>
      options.terminal?.(openPayload(approvalId, dispatch.id, dispatch.task_id)) ?? {
        ok: false,
        code: 'approval_not_open',
        message: 'gone'
      }
  )
  const runtime = {
    getOrchestrationDb: () => db,
    notifyMessageArrived: vi.fn(),
    terminalWorkerApprovals: { answer: terminalAnswer, isHeld: () => false },
    coordinatorApprovalsEnabled: () => options.coordinatorApprovals === true
  }
  const call = (decision: 'allow' | 'deny', access: Parameters<typeof answerWorkerApproval>[2]) =>
    answerWorkerApproval(
      { dispatch: dispatch.id, prompt: approvalId, decision },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
      { runtime: runtime as never },
      access
    )
  /** Runs the method's access rule, then its handler, as the RPC layer does. */
  const answerAs = async (
    caller: 'person' | 'agent',
    decision: 'allow' | 'deny',
    reason: string | undefined
  ) => {
    const params = { dispatch: dispatch.id, prompt: approvalId, decision, reason }
    const rpc = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule and handler read only these runtime members.
      runtime: runtime as never,
      ...(caller === 'person' ? { caller: { kind: 'desktop' as const } } : {})
    }
    return answerWorkerApproval(
      params,
      rpc,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only params, caller and the setting.
      workerApprovalAccess({ params, ctx: rpc as never, caller: undefined })
    )
  }
  const closingMessages = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.subject.startsWith('Worker approval '))
  const closings = () => closingMessages().map((message) => message.body)
  const closedWith = () =>
    closingMessages().map((message) => JSON.parse(message.payload ?? '{}').approval.outcome)
  const mailToWorker = () =>
    z
      .object({ body: z.string() })
      .array()
      .parse(
        db.db
          .prepare(`SELECT body FROM messages WHERE to_handle = ?`)
          .all(`dispatch:${dispatch.id}`)
      )
  return { call, answerAs, closings, closedWith, mailToWorker, terminalAnswer }
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
})

const REASON = 'The tests need the build folder cleared.'
const answeredByOrca = (decision: 'allow' | 'deny') => ({
  ok: true as const,
  prompt: {
    revision: 2,
    body: {
      ...item('trusted-local:orchestration:approval:x'),
      resolution: {
        state: 'resolved' as const,
        selectedOptionId: decision,
        resolvedBy: 'trusted-local:orchestration:approval:x',
        resolvedAt: 2
      }
    }
  },
  optionLabel: decision === 'allow' ? 'Allow' : 'Deny'
})

type Row = {
  setting: 'on' | 'off'
  caller: 'person' | 'agent'
  decision: 'allow' | 'deny'
  reason?: string
  worker: 'chat' | 'terminal'
  /** What the worker's side does with the answer. */
  meanwhile:
    | 'takes it'
    | 'answered first by the person'
    | 'refuses it'
    | 'is a person-only check'
    | 'drops the allow'
  expected: { ok: true; outcome: object; mailed: string[] } | { code: string; closing: string[] }
}

// Every outcome of the coordinator-approval setting, hardcoded.
const ROWS: Row[] = [
  {
    setting: 'off',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'chat',
    meanwhile: 'takes it',
    expected: { code: 'approval_requires_person', closing: [] }
  },
  {
    setting: 'off',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'terminal',
    meanwhile: 'takes it',
    expected: { code: 'approval_requires_person', closing: [] }
  },
  {
    setting: 'off',
    caller: 'agent',
    decision: 'deny',
    reason: 'Use a script file.',
    worker: 'chat',
    meanwhile: 'takes it',
    expected: {
      ok: true,
      outcome: { by: 'coordinator', decision: 'deny', reason: 'Use a script file.' },
      mailed: ['Use a script file.']
    }
  },
  {
    setting: 'off',
    caller: 'person',
    decision: 'allow',
    worker: 'chat',
    meanwhile: 'takes it',
    expected: { ok: true, outcome: { by: 'person', decision: 'allow', reason: null }, mailed: [] }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'chat',
    meanwhile: 'takes it',
    expected: {
      ok: true,
      outcome: { by: 'coordinator', decision: 'allow', reason: REASON, reasonDelivered: false },
      mailed: []
    }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'terminal',
    meanwhile: 'takes it',
    expected: {
      ok: true,
      outcome: { by: 'coordinator', decision: 'allow', reason: REASON, reasonDelivered: false },
      mailed: []
    }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'deny',
    reason: 'Use a script file.',
    worker: 'terminal',
    meanwhile: 'takes it',
    expected: {
      ok: true,
      outcome: {
        by: 'coordinator',
        decision: 'deny',
        reason: 'Use a script file.',
        reasonDelivered: true
      },
      mailed: []
    }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    worker: 'chat',
    meanwhile: 'takes it',
    expected: { code: 'invalid_argument', closing: [] }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'chat',
    meanwhile: 'answered first by the person',
    expected: {
      code: 'approval_not_open',
      closing: ["Allowed in the worker's own chat: approval item_1"]
    }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'chat',
    meanwhile: 'refuses it',
    expected: { code: 'approval_refused', closing: [] }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'chat',
    meanwhile: 'is a person-only check',
    expected: { code: 'approval_requires_person', closing: [] }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'deny',
    reason: 'Use a script file.',
    worker: 'chat',
    meanwhile: 'is a person-only check',
    expected: {
      ok: true,
      outcome: { by: 'coordinator', decision: 'deny', reason: 'Use a script file.' },
      mailed: ['Use a script file.']
    }
  },
  {
    setting: 'on',
    caller: 'agent',
    decision: 'allow',
    reason: REASON,
    worker: 'terminal',
    meanwhile: 'drops the allow',
    expected: { code: 'approval_requires_person', closing: [] }
  }
]

describe('coordinator approvals: every outcome', () => {
  it.each(ROWS)(
    'setting $setting, $caller $decision on a $worker worker that $meanwhile',
    async (row) => {
      chat.custody = row.worker === 'chat' ? 'chat' : 'terminal'
      chat.prompt = {
        revision: 1,
        body: {
          ...item(null),
          ...(row.meanwhile === 'is a person-only check' ? { personOnly: true as const } : {})
        }
      }
      chat.answer.mockReset()
      chat.answer.mockImplementation(async (input) => {
        switch (row.meanwhile) {
          case 'takes it':
            return answeredByOrca(row.decision)
          case 'answered first by the person':
            chat.prompt = { revision: 2, body: item('desktop-renderer') }
            return { ok: false, code: 'approval_not_open', message: 'gone' }
          case 'refuses it':
            return { ok: false, code: 'approval_refused', message: 'refused' }
          default: {
            // The real person-only check runs before any chat is reached; past it, the answer lands.
            const checked = await answerChatWorkerApproval({
              ...input,
              readPrompt: async () => chat.prompt
            })
            return !checked.ok && checked.code === 'approval_requires_person'
              ? checked
              : answeredByOrca(row.decision)
          }
        }
      })
      const ctx = setup('item_1', {
        coordinatorApprovals: row.setting === 'on',
        terminal: (payload) =>
          row.meanwhile === 'drops the allow'
            ? { ok: false, code: 'approval_requires_person', message: 'person only' }
            : { ok: true, approval: payload }
      })

      const answering = ctx.answerAs(row.caller, row.decision, row.reason)

      if ('code' in row.expected) {
        await expect(answering).rejects.toMatchObject({ code: row.expected.code })
        expect(ctx.closings()).toEqual(
          row.expected.closing.map((text) => expect.stringContaining(text))
        )
        return
      }
      await expect(answering).resolves.toMatchObject({ decision: row.decision })
      expect(ctx.closedWith()).toEqual([expect.objectContaining(row.expected.outcome)])
      expect(ctx.mailToWorker()).toEqual(row.expected.mailed.map((body) => ({ body })))
    }
  )
})
