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

const PANE = makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
const HANDLE = 'term_worker'

function setup(options: { canAnswer?: boolean } = {}) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'approvals',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, HANDLE, PANE)
  const screen: { dialog: boolean | null } = { dialog: true }
  const timers: { run: () => void; cancelled: boolean }[] = []
  const holds = new TerminalWorkerApprovalHolds({
    notify: vi.fn(),
    resolveWorker: () => ({ db, handle: HANDLE, dispatch }),
    canAnswerPane: () => options.canAnswer ?? true,
    showsDialog: () => screen.dialog,
    setTimer: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    }
  })
  /** Runs every timer due now, then lets awaited replies settle. */
  const tick = async (): Promise<void> => {
    for (const timer of timers.splice(0)) {
      if (!timer.cancelled) {
        timer.run()
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  const closing = () =>
    db
      .getUnreadRunMailbox(run.id, 100)
      .filter((message) => message.type === 'status')
      .map((message) => message.body)
  return { db, dispatch, screen, holds, tick, closing }
}

function hook(toolUseId: string | undefined, promptId = 'prompt-1') {
  const replies: (ClaudePermissionVerdict | null)[] = []
  const ends: ((why: ClaudePermissionHoldEnd) => void)[] = []
  const event: AgentHookEventPayload = {
    paneKey: PANE,
    connectionId: null,
    hookEventName: 'PermissionRequest',
    ...(toolUseId ? { toolUseId } : {}),
    payload: {
      state: 'blocked',
      prompt: '',
      agentType: 'claude',
      toolName: 'Bash',
      toolInput: 'rm -rf build'
    }
  }
  return {
    replies,
    end: (why: ClaudePermissionHoldEnd) => ends.forEach((listener) => listener(why)),
    request: {
      event,
      promptId,
      openChannel: () => ({
        answer: async (verdict: ClaudePermissionVerdict | null) => {
          replies.push(verdict)
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

describe('terminal worker approval holds', () => {
  it('passes requests it cannot name, or whose pane it cannot answer', () => {
    expect(setup().holds.admit(hook(undefined).request)).toBe(false)
    expect(setup({ canAnswer: false }).holds.admit(hook('tool-1').request)).toBe(false)
  })

  it('answers a deny once, with its message, and only when Claude takes it', async () => {
    const { holds, screen, tick, dispatch } = setup()
    const asked = hook('tool-1')
    expect(holds.admit(asked.request)).toBe(true)
    const approval = holds.takeOpenApproval(PANE, dispatch.id)
    expect(approval).toMatchObject({ state: 'open', allowedActions: ['allow', 'deny'] })

    const answering = holds.answer({
      dispatchId: dispatch.id,
      approvalId: approval!.approvalId,
      decision: 'deny',
      message: 'use a script file'
    })
    await tick()
    screen.dialog = false
    await tick()
    expect(await answering).toMatchObject({ ok: true })
    expect(asked.replies).toEqual([{ behavior: 'deny', message: 'use a script file' }])

    expect(
      await holds.answer({
        dispatchId: dispatch.id,
        approvalId: approval!.approvalId,
        decision: 'deny',
        message: 'again'
      })
    ).toMatchObject({ ok: false, code: 'approval_not_open' })
  })

  it('says the answer was not taken when the dialog stays', async () => {
    const { holds, tick, dispatch } = setup()
    holds.admit(hook('tool-1').request)
    const { approvalId } = holds.takeOpenApproval(PANE, dispatch.id)!
    const answering = holds.answer({
      dispatchId: dispatch.id,
      approvalId,
      decision: 'deny',
      message: 'no'
    })
    for (let i = 0; i < 20; i++) {
      await tick()
    }
    expect(await answering).toMatchObject({ ok: false, code: 'approval_refused' })
  })

  it('releases both prompts when a second opens in the same pane', () => {
    const { holds, dispatch } = setup()
    const first = hook('tool-1')
    holds.admit(first.request)
    expect(holds.admit(hook('tool-2').request)).toBe(false)
    expect(first.replies).toEqual([null])
    expect(holds.takeOpenApproval(PANE, dispatch.id)).toBeNull()
  })

  it('closes once the dialog leaves, and names an allow in the terminal from the tool result', async () => {
    const { holds, screen, tick, dispatch, closing } = setup()
    const asked = hook('tool-1')
    holds.admit(asked.request)
    const { approvalId } = holds.takeOpenApproval(PANE, dispatch.id)!
    await tick()
    screen.dialog = false
    await tick()
    expect(asked.replies).toEqual([null])
    expect(
      await holds.answer({ dispatchId: dispatch.id, approvalId, decision: 'deny', message: 'no' })
    ).toMatchObject({ ok: false, code: 'approval_not_open' })

    holds.observe(postToolUse('tool-1'))
    expect(closing()).toEqual([expect.stringContaining("Allowed in the worker's terminal")])
  })

  it("names a deny in the terminal when Claude ends the waiting hook (the person's No)", () => {
    const { holds, dispatch, closing } = setup()
    const asked = hook('tool-1')
    holds.admit(asked.request)
    holds.takeOpenApproval(PANE, dispatch.id)
    asked.end('hook-gone')
    expect(closing()).toEqual([expect.stringContaining("Denied in the worker's terminal")])
  })
})
