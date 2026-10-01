import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { USER_MESSAGE } from './claude-structured-session-test-support'

it('refuses stale continuation work after waiting for the SDK input pump', async () => {
  const queue = createClaudeUserMessageQueue()
  const queued = Promise.withResolvers<void>()
  const send = vi.fn((_message, beforeDispatch?: () => Promise<void>) => {
    const result = queue.push(
      {
        type: 'user',
        session_id: 'provider-session',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'continue' }
      },
      beforeDispatch
    )
    queued.resolve()
    return result
  })
  const session = sessionFor(send)
  session.connection.send = send
  let superseded = false
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  const beforeDispatch = vi.fn(async () => {
    if (superseded) {
      throw refusal
    }
  })
  const result = dispatchClaudeTurn(session, { body: USER_MESSAGE }, beforeDispatch).catch(
    (error: unknown) => error
  )
  await queued.promise
  expect(beforeDispatch).not.toHaveBeenCalled()
  expect(session.dispatchWaiters).toEqual([])
  superseded = true
  queue.end()
  const pump = queue.messages[Symbol.asyncIterator]()
  const handedOff = await pump.next()
  await pump.return?.()
  expect(handedOff.done).toBe(true)
  expect(await result).toBe(refusal)
  expect(beforeDispatch).toHaveBeenCalledOnce()
  expect(session.dispatchWaiters).toEqual([])
  expect(session.retiredDispatchWaiters).toEqual([])
})

it.each(['exit', 'capacity'] as const)(
  'refuses %s during authorization without leaked correlation',
  async (failure) => {
    const queue = createClaudeUserMessageQueue()
    const authorizing = Promise.withResolvers<void>()
    const authorized = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const session = sessionFor()
    session.connection.send = (_message, beforeDispatch) => {
      const result = queue.push(
        {
          type: 'user',
          session_id: 'provider-session',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'continue' }
        },
        beforeDispatch
      )
      queued.resolve()
      return result
    }
    const beforeDispatch = vi.fn(() => {
      authorizing.resolve()
      return authorized.promise
    })
    const result = dispatchClaudeTurn(session, { body: USER_MESSAGE }, beforeDispatch)
    await queued.promise
    const pump = queue.messages[Symbol.asyncIterator]()
    const handedOff = pump.next()
    await authorizing.promise
    if (failure === 'exit') {
      queue.fail(new Error('provider exited'))
    } else {
      session.connection.send = vi.fn().mockResolvedValue(undefined)
      for (let index = 0; index < 64; index += 1) {
        await dispatchClaudeTurn(session, {
          body: USER_MESSAGE,
          clientMessageId: `ordinary-${index}`
        })
      }
      queue.end()
    }
    authorized.resolve()
    expect((await handedOff).done).toBe(true)
    expect(await result).toMatchObject({ state: 'rejected' })
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(session.dispatchWaiters).toHaveLength(failure === 'exit' ? 0 : 64)
    expect(session.retiredDispatchWaiters).toEqual([])
  }
)
