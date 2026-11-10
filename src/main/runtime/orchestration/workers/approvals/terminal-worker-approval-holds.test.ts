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
import type { ClaudeToolResult } from './claude-tool-result-close'

const PANE = makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
const HANDLE = 'term_worker'

// Screens as Claude 2.1.322 leaves them (probe captures in design.md F2–F5).
const DIALOG = [
  ' Bash command',
  ' │ rm -rf build',
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
const AUTO_BLOCKED: ClaudeToolResult = {
  isError: true,
  text: 'Permission for this command was denied by a built-in Claude Code safety check, not by the user.'
}
const RAN: ClaudeToolResult = { isError: false, text: '59' }

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
    readToolResult: ({ transcriptPath, toolUseId }) =>
      transcriptPath === '/t/session.jsonl' && toolUseId === 'tool-1' ? screen.result : null,
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
  const closing = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.type === 'status')
      .map((message) => message.body)
  return { dispatch, screen, holds, tick, closing }
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
  it('passes requests it cannot name, or whose pane it cannot answer', () => {
    expect(setup().holds.admit(hook(undefined).request)).toBe(false)
    expect(setup({ canAnswer: false }).holds.admit(hook('tool-1').request)).toBe(false)
  })

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

  it('does not claim a deny that lost to a Yes, even with an older deny line on screen', async () => {
    const ctx = setup()
    const asked = hook('tool-1', () => {
      ctx.screen.lines = AFTER
      ctx.screen.result = RAN
    })
    const approvalId = await opened(ctx, asked)

    expect(await deny(ctx, approvalId)).toMatchObject({ ok: false, code: 'approval_not_open' })
    expect(ctx.closing()).toEqual([expect.stringContaining("Allowed in the worker's terminal")])
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

  it("does not claim a deny that lost to Claude's 2:00 auto-block", async () => {
    const ctx = setup()
    const asked = hook('tool-1', () => (ctx.screen.result = AUTO_BLOCKED))
    const approvalId = await opened(ctx, asked)

    expect(await deny(ctx, approvalId)).toMatchObject({ ok: false, code: 'approval_not_open' })
    expect(ctx.closing()).toEqual([expect.stringContaining('on its own (its 2:00 timeout)')])
  })

  it('writes nothing to a dialog the caught-up screen no longer shows', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    const approvalId = await opened(ctx, asked)
    ctx.screen.lines = AFTER

    expect(await deny(ctx, approvalId)).toMatchObject({ ok: false, code: 'approval_not_open' })
    expect(asked.replies.filter(Boolean)).toEqual([])
  })

  it('refuses an answer once the agent in the pane was restarted', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    const approvalId = await opened(ctx, asked)
    ctx.screen.incarnation = 'run-2'

    expect(await deny(ctx, approvalId)).toMatchObject({ ok: false, code: 'approval_not_open' })
    expect(asked.replies).toEqual([])
  })

  it('releases both prompts when a second opens in the same pane', () => {
    const ctx = setup()
    const first = hook('tool-1')
    ctx.holds.admit(first.request)
    expect(ctx.holds.admit(hook('tool-2').request)).toBe(false)
    expect(first.replies).toEqual([null])
    expect(ctx.holds.takeOpenApproval(PANE, ctx.dispatch.id)).toBeNull()
  })

  it("names a No in the terminal from this call's tool_result once the dialog leaves", async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    await opened(ctx, asked)
    ctx.screen.lines = AFTER
    ctx.screen.result = USER_NO
    await ctx.tick(3)

    expect(asked.replies).toEqual([null])
    expect(ctx.closing()).toEqual([expect.stringContaining("Denied in the worker's terminal")])
  })

  it('treats a killed hook with the dialog still up as answerable only in the terminal', async () => {
    const ctx = setup()
    const asked = hook('tool-1')
    await opened(ctx, asked)

    asked.end('hook-gone')
    await ctx.tick(80)
    expect(ctx.closing()).toEqual([
      expect.stringContaining("a person must answer it in the worker's terminal")
    ])
  })
})
