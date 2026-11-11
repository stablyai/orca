import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  ClaudePermissionHoldEnd,
  ClaudePermissionVerdict
} from '../../../../agent-hooks/server/claude-permission-hook-hold'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { TerminalWorkerApprovalHolds } from './terminal-worker-approval-holds'
import { closeOrphanedTerminalApprovals } from './terminal-approval-orphans'
import { approvalReportId } from './worker-approval-report'
import type { ClaudeToolResult } from './claude-tool-result-close'

const PANE = makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
const HANDLE = 'term_worker'

// Screens as Claude 2.1.322 leaves them (probe captures in design.md F2–F5).
const DIALOG = [
  ' Bash command',
  ' │ rm -rf build',
  ' ⚠ Claude Code will automatically block this request in 1:42, to avoid holding up an unattended session',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel · Tab to amend'
]

// An earlier prompt's deny stays on screen: only this call's tool_result says how it closed.
const AFTER = [
  '● Bash(rm -rf old)',
  '  ⎿  Denied by PermissionRequest hook',
  '● Bash(rm -rf build)'
]
const REASON = 'use a script file'
// tool_result texts as Claude 2.1.322 records them (probe 2026-11-10).
const OURS: ClaudeToolResult = { isError: true, text: REASON }
const USER_NO: ClaudeToolResult = {
  isError: true,
  text: "The user doesn't want to proceed with this tool use. The tool use was rejected."
}

function setup(options: { canAnswer?: boolean } = {}) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, HANDLE, PANE)
  const screen: {
    lines: readonly string[] | null
    incarnation: string
    result: ClaudeToolResult | null
  } = { lines: DIALOG, incarnation: 'run-1', result: null }
  const timers: { run: () => void; cancelled: boolean }[] = []
  const holds = new TerminalWorkerApprovalHolds({
    notify: vi.fn(),
    resolveWorker: () => ({ db, handle: HANDLE, dispatch }),
    canAnswerPane: () => options.canAnswer ?? true,
    processIncarnation: () => screen.incarnation,
    readScreen: () => screen.lines,
    readToolResult: async ({ transcriptPath, toolUseId }) =>
      transcriptPath === '/t/session.jsonl' && toolUseId === 'tool-1' ? screen.result : null,
    now: () => Date.UTC(2026, 10, 10, 12, 0, 0),
    setTimer: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    }
  })
  /** Runs every timer due now, then lets awaited replies settle. */
  const tick = async (rounds = 1): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled) {
          timer.run()
        }
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const closings = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.subject.startsWith('Worker approval '))
  const closing = () => closings().map((message) => message.body)
  return { db, dispatch, screen, holds, tick, closing, closings }
}

function hook(
  toolUseId: string | undefined,
  onWrite?: (verdict: ClaudePermissionVerdict | null) => void
) {
  const replies: (ClaudePermissionVerdict | null)[] = []
  const ends: ((why: ClaudePermissionHoldEnd) => void)[] = []
  const event: AgentHookEventPayload = {
    paneKey: PANE,
    connectionId: null,
    hookEventName: 'PermissionRequest',
    ...(toolUseId ? { toolUseId } : {}),
    payload: { state: 'blocked', prompt: '', agentType: 'claude', toolName: 'Bash' },
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath: '/t/session.jsonl' }
  }
  return {
    replies,
    end: (why: ClaudePermissionHoldEnd) => ends.forEach((listener) => listener(why)),
    request: {
      event,
      promptId: 'prompt-1',
      openChannel: () => ({
        answer: async (verdict: ClaudePermissionVerdict | null) => {
          replies.push(verdict)
          onWrite?.(verdict)
          return true
        },
        onEnd: (listener: (why: ClaudePermissionHoldEnd) => void) => {
          ends.push(listener)
        }
      })
    }
  }
}

function postToolUse(toolUseId: string): AgentHookEventPayload {
  return {
    paneKey: PANE,
    connectionId: null,
    hookEventName: 'PostToolUse',
    toolUseId,
    payload: { state: 'working', prompt: '', agentType: 'claude' }
  }
}

async function opened(ctx: ReturnType<typeof setup>, asked: ReturnType<typeof hook>) {
  ctx.holds.admit(asked.request)
  await ctx.tick()
  return ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)!.approvalId
}

const deny = (ctx: ReturnType<typeof setup>, approvalId: string) =>
  ctx.holds.answer({
    dispatchId: ctx.dispatch.id,
    approvalId,
    decision: 'deny',
    message: REASON
  })

describe('terminal worker approval holds', () => {
  it("claims a deny only from this call's tool_result, despite an older deny line on screen", async () => {
    const ctx = setup()
    const asked = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.screen.result = OURS
    })
    const approvalId = await opened(ctx, asked)

    expect(await deny(ctx, approvalId)).toMatchObject({ ok: true })
    expect(asked.replies).toEqual([{ behavior: 'deny', message: REASON }])
    expect(await deny(ctx, approvalId)).toMatchObject({ ok: false, code: 'approval_not_open' })
  })

  it('names a Yes whose PostToolUse arrived while the deny was in flight', async () => {
    const ctx = setup()
    const asked = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.holds.observe(postToolUse('tool-1'))
    })
    const approvalId = await opened(ctx, asked)
    const answering = deny(ctx, approvalId)
    await ctx.tick(40)

    expect(await answering).toMatchObject({ ok: false, code: 'approval_not_open' })
    expect(ctx.closing()).toEqual([expect.stringContaining("Allowed in the worker's terminal")])
  })

  it("closes the card when the dialog leaves, and names it from a result read on the lead's Stop", async () => {
    const ctx = setup()
    await opened(ctx, hook('tool-1'))
    ctx.screen.lines = AFTER
    // Only until it closes awaiting a result: further ticks would fire its 10-minute fallback.
    for (let i = 0; i < 80 && ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id); i++) {
      await ctx.tick()
    }
    ctx.screen.result = USER_NO
    ctx.holds.observe({
      paneKey: PANE,
      connectionId: null,
      hookEventName: 'Stop',
      payload: { state: 'done', prompt: '', agentType: 'claude' }
    })
    await vi.waitFor(() => expect(ctx.closing()).toHaveLength(2))

    // The card closed when the dialog left; the late result only names how.
    expect(ctx.closing()).toEqual([
      expect.stringContaining('Closed without an answer Orca can name'),
      expect.stringContaining("Denied in the worker's terminal")
    ])
  })

  it('closes a prompt left open by an earlier run, once, when the database opens', () => {
    const ctx = setup()
    ctx.holds.admit(hook('tool-1').request)
    const approval = ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)!
    const escalate = (id: string | undefined, carried: typeof approval) =>
      ctx.db.insertMessage({
        ...(id ? { id } : {}),
        from: HANDLE,
        to: 'term_coordinator',
        subject: 'Worker is waiting for permission',
        type: 'escalation',
        payload: JSON.stringify({ handle: HANDLE, dispatchId: ctx.dispatch.id, approval: carried }),
        runId: ctx.dispatch.run_id
      })
    escalate(approvalReportId(ctx.dispatch.id, approval.approvalId, 'open'), approval)
    // A worker's own escalation carrying an approval is not Orca's, so the sweep leaves it alone.
    escalate(undefined, { ...approval, approvalId: 'apr_forged' })

    closeOrphanedTerminalApprovals(ctx.db)
    closeOrphanedTerminalApprovals(ctx.db)
    expect(ctx.closing()).toEqual([
      expect.stringContaining(
        `Closed without an answer Orca can name: approval ${approval.approvalId}`
      )
    ])
  })
})
