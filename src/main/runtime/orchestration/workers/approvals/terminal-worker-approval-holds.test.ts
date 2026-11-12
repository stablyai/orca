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
import type { ClaudeToolRecord, ClaudeToolResult } from './claude-tool-result-close'

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
/** What the transcript holds: the hook decision Claude took, then the tool's result. */
const record = (
  result: ClaudeToolResult | null,
  hookDecision: ClaudeToolRecord['hookDecision'] = null
): ClaudeToolRecord => ({ hookDecision, result })

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
    record: ClaudeToolRecord | null
  } = { lines: DIALOG, incarnation: 'run-1', record: null }
  const timers: { run: () => void; cancelled: boolean }[] = []
  const holds = new TerminalWorkerApprovalHolds({
    notify: vi.fn(),
    resolveWorker: () => ({ db, handle: HANDLE, dispatch }),
    canAnswerPane: () => options.canAnswer ?? true,
    processIncarnation: () => screen.incarnation,
    readScreen: () => screen.lines,
    readToolRecord: async ({ transcriptPath, toolUseId }) =>
      transcriptPath === '/t/session.jsonl' && toolUseId === 'tool-1' ? screen.record : null,
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
  const closedWith = () =>
    closings().map((message) => {
      const { approval } = JSON.parse(message.payload ?? '{}')
      return { state: approval.state, ...approval.outcome }
    })
  return { db, dispatch, screen, holds, tick, closing, closings, closedWith }
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

/** Takes the open approval and marks its escalation sent, as the turn-stop report does. */
async function escalated(ctx: ReturnType<typeof setup>) {
  const approval = (await ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id))!
  ctx.holds.markReported(approval.approvalId)
  return approval
}

async function opened(ctx: ReturnType<typeof setup>, asked: ReturnType<typeof hook>) {
  ctx.holds.admit(asked.request)
  await ctx.tick()
  return (await escalated(ctx)).approvalId
}

const answer = (
  ctx: ReturnType<typeof setup>,
  approvalId: string,
  decision: 'allow' | 'deny' = 'deny'
) => ctx.holds.answer({ dispatchId: ctx.dispatch.id, approvalId, decision, message: REASON })
const deny = (ctx: ReturnType<typeof setup>, approvalId: string) => answer(ctx, approvalId)

/** The dialog leaves without Orca's answer, then the lead's turn ends with `result` written. */
async function closedInTerminal(ctx: ReturnType<typeof setup>, result: ClaudeToolResult) {
  const approvalId = await opened(ctx, hook('tool-1'))
  ctx.screen.lines = AFTER
  // Only until it closes awaiting a result: further ticks would fire its 10-minute fallback.
  for (let i = 0; i < 80 && ctx.holds.isHeld(approvalId); i++) {
    await ctx.tick()
  }
  ctx.screen.record = record(result)
  ctx.holds.observe({
    paneKey: PANE,
    connectionId: null,
    hookEventName: 'Stop',
    payload: { state: 'done', prompt: '', agentType: 'claude' }
  })
  await vi.waitFor(() => expect(ctx.closing()).toHaveLength(2))
}

describe('terminal worker approval holds', () => {
  it("claims a deny only from this call's tool_result, despite an older deny line on screen", async () => {
    const ctx = setup()
    const asked = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.screen.record = record(OURS, 'deny')
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
    await closedInTerminal(ctx, USER_NO)

    // The card closed when the dialog left; the late result only names how.
    expect(ctx.closing()).toEqual([
      expect.stringContaining('Closed without an answer Orca can name'),
      expect.stringContaining("Denied in the worker's terminal")
    ])
    // Not an expiry: only the agent's own timeout is one.
    expect(ctx.closedWith()[0]).toMatchObject({ state: 'answered', by: 'unknown' })
  })

  it('marks a check Claude lets no hook approve as person-only, and refuses an allow without spending the hook', async () => {
    const ctx = setup()
    ctx.screen.lines = [
      ' Bash command',
      ' │ rm -rf build',
      ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      " │ Bash may act on this session's desktop, so each call is reviewed; allow rules, hooks and plugins cannot approve it.",
      ...DIALOG.slice(3)
    ]
    const asked = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.screen.record = record(OURS, 'deny')
    })
    ctx.holds.admit(asked.request)
    await ctx.tick()
    const approval = await escalated(ctx)
    const approvalId = approval.approvalId

    expect(approval).toMatchObject({ personOnly: true })
    expect(await answer(ctx, approvalId, 'allow')).toMatchObject({
      ok: false,
      code: 'approval_requires_person'
    })
    expect(asked.replies).toEqual([])
    expect(await deny(ctx, approvalId)).toMatchObject({ ok: true })
  })

  it('refuses an allow on a person-only check whose warning painted only after the escalation', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    const approvalId = await opened(ctx, asked)
    ctx.screen.lines = [
      ' Bash command',
      ' │ rm -rf build',
      ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      " │ Bash may act on this session's desktop, so each call is reviewed; allow rules, hooks and plugins cannot approve it.",
      ...DIALOG.slice(3)
    ]

    expect(await answer(ctx, approvalId, 'allow')).toMatchObject({
      code: 'approval_requires_person'
    })
    expect(asked.replies).toEqual([])
  })

  it('refuses an allow Claude drops while its dialog stays, and leaves the prompt with the person', async () => {
    const ctx = setup()
    // A check only a person may approve: Claude ignores a hook's allow and keeps asking.
    const approvalId = await opened(ctx, hook('tool-1'))
    const answering = answer(ctx, approvalId, 'allow')
    await ctx.tick(40)

    expect(await answering).toMatchObject({ ok: false, code: 'approval_requires_person' })
    expect(ctx.closedWith()).toEqual([
      expect.objectContaining({ by: 'terminal-only', decision: null })
    ])
  })

  it("doesn't take Orca's allow when the person's No won the race", async () => {
    const ctx = setup()
    const approvalId = await opened(
      ctx,
      hook('tool-1', () => {
        ctx.screen.lines = AFTER
        ctx.screen.record = record(USER_NO)
      })
    )

    expect(await answer(ctx, approvalId, 'allow')).toMatchObject({ code: 'approval_not_open' })
    expect(ctx.closedWith()).toEqual([
      {
        state: 'answered',
        by: 'worker-terminal',
        decision: 'deny',
        reason: null,
        reasonDelivered: false
      }
    ])
  })

  it("tells the coordinator to send the user to the terminal when the hook is gone but the dialog isn't", async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    await opened(ctx, asked)
    asked.end('hook-gone')
    await ctx.tick(40)

    expect(ctx.closings()).toEqual([
      expect.objectContaining({
        type: 'escalation',
        body: expect.stringContaining("Tell the user to answer it in the worker's terminal")
      })
    ])
  })

  it('closes as worker ended, not "answer it in the terminal", when the worker is stopped at the prompt', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    await opened(ctx, asked)
    // A stop kills the process; its last screen still shows the dialog.
    ctx.screen.incarnation = 'run-2'
    asked.end('hook-gone')
    await ctx.tick(40)

    expect(ctx.closedWith()).toEqual([
      {
        state: 'answered',
        by: 'worker-ended',
        decision: null,
        reason: null,
        reasonDelivered: false
      }
    ])
  })

  it("escalates with Claude's reason once the dialog paints, though a long command hides its box's top", async () => {
    const ctx = setup()
    // The live case (2026-11-11): the escalation came before the paint, and the command was so long
    // that only the rule closing its box was on screen.
    ctx.screen.lines = null
    ctx.holds.admit(hook('tool-1').request)
    const escalating = ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)
    ctx.screen.lines = [
      ...Array.from({ length: 30 }, (_, line) => ` │ s=s.replace("import ${line}")`),
      ' │ fs.writeFileSync(p,s)\'; rg -n "ComputerBots" BotSettingsGroups.tsx',
      ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' │ Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed',
      ...DIALOG.slice(2)
    ]
    await ctx.tick(2)

    expect((await escalating)?.summary.reason).toBe(
      'Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed'
    )
  })

  it('owes no closing line to a prompt whose escalation never went out', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    ctx.holds.admit(asked.request)
    // Taken, but the turn-stop report never sent it, so it is never marked reported.
    expect(await ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)).not.toBeNull()
    asked.end('hook-gone')
    await ctx.tick(40)

    expect(ctx.closings()).toEqual([])
  })

  it('closes a prompt left open by an earlier run, once, when the database opens', async () => {
    const ctx = setup()
    ctx.holds.admit(hook('tool-1').request)
    const approval = await escalated(ctx)
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
