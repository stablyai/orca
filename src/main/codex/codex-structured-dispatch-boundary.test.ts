import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import {
  acquiredCodexAdapter,
  CODEX_TEST_USER_MESSAGE,
  fakeCodexAppServer
} from './codex-structured-dispatch-test-support'

it('checks continuation authority after process capture and before writing turn/start', async () => {
  const capturing = Promise.withResolvers<void>()
  const captured = Promise.withResolvers<null>()
  const codex = fakeCodexAppServer()
  const adapter = await acquiredCodexAdapter({
    codex,
    settlements: [],
    captureTurnProcesses: () => {
      capturing.resolve()
      return captured.promise
    }
  })
  let superseded = false
  const beforeDispatch = vi.fn(async () => {
    if (superseded) {
      throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
    }
  })
  try {
    const result = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'continuation',
      body: CODEX_TEST_USER_MESSAGE,
      fence: 7,
      beforeDispatch
    })
    const verdict = result.catch((error: unknown) => error)
    await capturing.promise
    superseded = true
    captured.resolve(null)
    expect(await verdict).toBeInstanceOf(AgentSessionPreDispatchError)
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(false)
  } finally {
    captured.resolve(null)
    await adapter.closeAll()
  }
})
