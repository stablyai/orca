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

// A helper's calls are recorded only in its own transcript beside the session's.
const helperTranscript = (helper: string) => `/t/session/subagents/agent-${helper}.jsonl`
// The screen while a held helper prompt waits: Claude draws no dialog for it (probe 2026-11-19, 2.1.326).
const LEAD_WAITING = ['⏺ Agent(Run rm check)', '✻ Waiting for 1 background agent to finish', '❯']

function setup(options: { canAnswer?: boolean; coordinatorApprovals?: boolean } = {}) {
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
    /** Keyed by transcript path and tool call. */
    helperRecords: Map<string, ClaudeToolRecord>
  } = { lines: DIALOG, incarnation: 'run-1', record: null, helperRecords: new Map() }
  const timers: { run: () => void; cancelled: boolean }[] = []
  const holds = new TerminalWorkerApprovalHolds({
    notify: vi.fn(),
    getDb: () => db,
    isWaitingForMail: () => false,
    coordinatorApprovals: () => options.coordinatorApprovals ?? true,
    resolveWorker: () => ({ db, handle: HANDLE, dispatch }),
    canAnswerPane: () => options.canAnswer ?? true,
    processIncarnation: () => screen.incarnation,
    readScreen: () => screen.lines,
    readToolRecord: async ({ transcriptPath, toolUseId }) =>
      transcriptPath === '/t/session.jsonl' && toolUseId === 'tool-1'
        ? screen.record
        : (screen.helperRecords.get(`${transcriptPath}|${toolUseId}`) ?? null),
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
  const escalations = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.subject === 'Worker is waiting for permission')
  return { db, dispatch, screen, holds, tick, closing, closings, closedWith, escalations }
}

function hook(
  toolUseId: string | undefined,
  onWrite?: (verdict: ClaudePermissionVerdict | null) => void,
  helper?: string
) {
  const replies: (ClaudePermissionVerdict | null)[] = []
  const ends: ((why: ClaudePermissionHoldEnd) => void)[] = []
  const event: AgentHookEventPayload = {
    paneKey: PANE,
    connectionId: null,
    hookEventName: 'PermissionRequest',
    ...(toolUseId ? { toolUseId } : {}),
    ...(helper ? { toolAgentId: helper, toolAgentType: 'general-purpose' } : {}),
    payload: {
      state: 'blocked',
      prompt: '',
      agentType: 'claude',
      toolName: 'Bash',
      ...(helper ? { toolInput: `rm ${toolUseId}.txt` } : {})
    },
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

/** Allows, ticking only until answered: further ticks would fire its 10-minute evidence fallback. */
async function answeredAllow(ctx: ReturnType<typeof setup>, approvalId: string) {
  let answered: unknown = null
  void answer(ctx, approvalId, 'allow').then((result) => (answered = result))
  for (let i = 0; i < 40 && !answered; i++) {
    await ctx.tick()
  }
  return answered
}

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

  it("takes Orca's allow once the dialog leaves, though Claude records it only with a slow tool's result", async () => {
    const ctx = setup()
    const approvalId = await opened(
      ctx,
      hook('tool-1', () => {
        ctx.screen.lines = AFTER
      })
    )
    expect(await answeredAllow(ctx, approvalId)).toMatchObject({ ok: true })
    ctx.screen.record = record({ isError: false, text: 'built' }, 'allow')
    ctx.holds.observe(postToolUse('tool-1'))
    expect(ctx.closings()).toEqual([])
  })

  it("corrects an answered allow's receipt when the slow tool's result shows the person's No won", async () => {
    const ctx = setup()
    const approvalId = await opened(
      ctx,
      hook('tool-1', () => {
        ctx.screen.lines = AFTER
      })
    )
    expect(await answeredAllow(ctx, approvalId)).toMatchObject({ ok: true })

    ctx.screen.record = record(USER_NO)
    ctx.holds.observe({
      paneKey: PANE,
      connectionId: null,
      hookEventName: 'Stop',
      payload: { state: 'done', prompt: '', agentType: 'claude' }
    })
    await vi.waitFor(() =>
      expect(ctx.closedWith()).toEqual([
        expect.objectContaining({ by: 'worker-terminal', decision: 'deny' })
      ])
    )
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

describe("terminal worker approval holds for a helper agent's prompt", () => {
  const HELPER = 'a28760f4d40f595de'
  const OTHER_HELPER = 'a5a826dca766863e5'
  const helperAsks = (
    ctx: ReturnType<typeof setup>,
    toolUseId: string,
    onWrite?: (verdict: ClaudePermissionVerdict | null) => void,
    helper = HELPER
  ) => {
    const asked = hook(toolUseId, onWrite, helper)
    expect(ctx.holds.admit(asked.request)).toBe(true)
    return asked
  }
  const cardOf = (ctx: ReturnType<typeof setup>, index: number) => {
    const message = ctx.escalations()[index]
    return { body: message.body, approval: JSON.parse(message.payload ?? '{}').approval }
  }
  const deniedInHelperTranscript =
    (ctx: ReturnType<typeof setup>, toolUseId: string, helper = HELPER) =>
    () =>
      ctx.screen.helperRecords.set(`${helperTranscript(helper)}|${toolUseId}`, record(OURS, 'deny'))

  it("cards a helper's prompt at once and denies it without a dialog, claimed from the helper's transcript", async () => {
    const ctx = setup()
    ctx.screen.lines = LEAD_WAITING
    const asked = helperAsks(ctx, 'tool-2', deniedInHelperTranscript(ctx, 'tool-2'))

    const { body, approval } = cardOf(ctx, 0)
    expect(approval).toMatchObject({
      fromHelper: true,
      summary: {
        title: "Allow Bash? · from the worker's general-purpose helper",
        detail: 'rm tool-2.txt'
      }
    })
    expect(body).toContain(
      "A helper agent inside the worker asked, so the worker's terminal shows it only if nobody answers in Orca within 2 minutes."
    )
    expect(body).not.toContain('whoever answers first wins')
    expect(await deny(ctx, approval.approvalId)).toMatchObject({ ok: true })
    expect(asked.replies).toEqual([{ behavior: 'deny', message: REASON }])
  })

  it('gives two helpers prompting at once a card each, each answered and claimed from its own transcript', async () => {
    const ctx = setup()
    ctx.screen.lines = LEAD_WAITING
    const first = helperAsks(ctx, 'tool-2', deniedInHelperTranscript(ctx, 'tool-2'))
    const second = helperAsks(
      ctx,
      'tool-3',
      deniedInHelperTranscript(ctx, 'tool-3', OTHER_HELPER),
      OTHER_HELPER
    )

    expect(ctx.escalations()).toHaveLength(2)
    const cardFor = (detail: string) =>
      [0, 1]
        .map((index) => cardOf(ctx, index).approval)
        .find((card) => card.summary.detail === detail)
    expect(await deny(ctx, cardFor('rm tool-3.txt').approvalId)).toMatchObject({ ok: true })
    expect(first.replies).toEqual([])
    expect(second.replies).toEqual([{ behavior: 'deny', message: REASON }])
    expect(await deny(ctx, cardFor('rm tool-2.txt').approvalId)).toMatchObject({ ok: true })
    expect(first.replies).toEqual([{ behavior: 'deny', message: REASON }])
  })

  it("keeps the lead's on-screen prompt answerable while a helper's is held", async () => {
    const ctx = setup()
    const lead = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.screen.record = record(OURS, 'deny')
    })
    const leadId = await opened(ctx, lead)
    const helper = helperAsks(ctx, 'tool-2', deniedInHelperTranscript(ctx, 'tool-2'))

    expect(await deny(ctx, leadId)).toMatchObject({ ok: true })
    expect(await deny(ctx, cardOf(ctx, 0).approval.approvalId)).toMatchObject({ ok: true })
    expect(lead.replies).toEqual([{ behavior: 'deny', message: REASON }])
    expect(helper.replies).toEqual([{ behavior: 'deny', message: REASON }])
  })

  it("names a lead's stop by a held helper's card, but leaves an unheld dialog on screen to its own report", async () => {
    const ctx = setup()
    ctx.screen.lines = LEAD_WAITING
    helperAsks(ctx, 'tool-2')
    const helperId = cardOf(ctx, 0).approval.approvalId

    expect(await ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)).toMatchObject({
      approvalId: helperId
    })
    ctx.screen.lines = DIALOG
    expect(await ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)).toBeNull()
  })

  it("hands a helper's prompt to the worker's terminal when Orca's hold ends unanswered", async () => {
    const ctx = setup()
    ctx.screen.lines = LEAD_WAITING
    const asked = helperAsks(ctx, 'tool-2')
    asked.end('budget')
    await ctx.tick(40)

    expect(ctx.closing()).toEqual([
      expect.stringContaining("Closed for Orca; a person must answer it in the worker's terminal")
    ])
  })
})
