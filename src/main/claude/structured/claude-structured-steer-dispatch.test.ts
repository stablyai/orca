import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeMessage } from './launch/claude-structured-message-options'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'
import type { ClaudeSession } from './claude-structured-session-state'

const SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

function runningSession(): { session: ClaudeSession; steps: string[]; sent: unknown[] } {
  const steps: string[] = []
  const sent: unknown[] = []
  const session = sessionFor(
    vi.fn(async (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => {
      await beforeDispatch?.()
      steps.push('write')
      sent.push(structuredClone(message))
    })
  )
  Object.assign(session.connection, {
    backgroundTask: vi.fn(async (toolUseId: string) => {
      steps.push(`background ${toolUseId}`)
      return true
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only these translator flags.
  session.translator = {
    openTurnHasInputWork: true,
    commandTurnId: null
  } as unknown as ClaudeSession['translator']
  // Shapes from Claude CLI 2.1.319: a foreground subagent, and a foreground command it runs.
  session.childWork.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-parent',
    tool_use_id: 'toolu_parent',
    is_backgrounded: false,
    spawn_depth: 1,
    task_type: 'local_agent',
    session_id: SESSION
  })
  session.childWork.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'shell-child',
    owned_by_subagent: true,
    tool_use_id: 'toolu_shell',
    is_backgrounded: false,
    parent_task_id: 'agent-parent',
    task_type: 'local_bash',
    session_id: SESSION
  })
  return { session, steps, sent }
}

const steer = {
  sessionId: 'session-1',
  clientMessageId: 'client-1',
  body: userMessage([{ type: 'text', text: 'change course' }]),
  fence: 1
}

describe('Claude steer dispatch', () => {
  it('backgrounds only top-level foreground work, then interrupts the running step', async () => {
    const { session, steps, sent } = runningSession()

    await expect(dispatchClaudeMessage(session, steer, undefined)).resolves.toMatchObject({
      state: 'admitted'
    })
    // The subagent's own command must stay in its foreground, or it dies when the subagent ends.
    expect(steps).toEqual(['background toolu_parent', 'write'])
    expect(sent).toEqual([expect.objectContaining({ priority: 'now' })])
  })

  it('still steers when Claude refuses the background request', async () => {
    const { session, sent } = runningSession()
    session.connection.backgroundTask = vi.fn(async () => {
      throw new Error('background tasks are disabled')
    })

    await dispatchClaudeMessage(session, steer, undefined, { warn: () => {}, error: () => {} })
    expect(sent).toEqual([expect.objectContaining({ priority: 'now' })])
  })
})
