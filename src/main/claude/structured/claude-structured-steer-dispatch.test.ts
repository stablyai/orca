import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeMessage } from './launch/claude-structured-message-options'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'
import type { ClaudeSession } from './claude-structured-session-state'

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
    backgroundTasks: vi.fn(async () => {
      steps.push('background_tasks')
      return true
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only these translator flags.
  session.translator = {
    openTurnHasInputWork: true,
    commandTurnId: null
  } as unknown as ClaudeSession['translator']
  return { session, steps, sent }
}

describe('Claude steer dispatch', () => {
  it('backgrounds foreground work, then interrupts the running step with the steer', async () => {
    const { session, steps, sent } = runningSession()

    await expect(
      dispatchClaudeMessage(
        session,
        {
          sessionId: 'session-1',
          clientMessageId: 'client-1',
          body: userMessage([{ type: 'text', text: 'change course' }]),
          fence: 1
        },
        undefined
      )
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(steps).toEqual(['background_tasks', 'write'])
    expect(sent).toEqual([expect.objectContaining({ priority: 'now' })])
  })

  it('still steers when Claude refuses the background request', async () => {
    const { session, sent } = runningSession()
    session.connection.backgroundTasks = vi.fn(async () => {
      throw new Error('background tasks are disabled')
    })

    await dispatchClaudeMessage(
      session,
      {
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'change course' }]),
        fence: 1
      },
      undefined,
      { warn: () => {}, error: () => {} }
    )
    expect(sent).toEqual([expect.objectContaining({ priority: 'now' })])
  })
})
