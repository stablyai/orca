import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import {
  acquiredCodexAdapter,
  CODEX_TEST_USER_MESSAGE,
  fakeCodexAppServer
} from './codex-structured-dispatch-test-support'

it('checks continuation authority before writing turn/start', async () => {
  const codex = fakeCodexAppServer()
  const adapter = await acquiredCodexAdapter({ codex, settlements: [] })
  const beforeDispatch = vi.fn(async () => {
    throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  })
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'continuation',
        body: CODEX_TEST_USER_MESSAGE,
        fence: 7,
        beforeDispatch
      })
    ).rejects.toBeInstanceOf(AgentSessionPreDispatchError)
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})
