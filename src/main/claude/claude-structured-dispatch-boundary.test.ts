import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { acquired, fakeClaude, USER_MESSAGE } from './claude-structured-session-test-support'

it('does not enqueue a continuation refused at the provider dispatch boundary', async () => {
  const claude = fakeClaude()
  const settled = vi.fn()
  const adapter = await acquired(claude, {}, [], settled)
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'continuation',
        body: USER_MESSAGE,
        fence: 7,
        beforeDispatch: async () => {
          throw refusal
        }
      })
    ).rejects.toBe(refusal)
    expect(claude.connections[0]?.sent).toEqual([])
    expect(settled).not.toHaveBeenCalled()
  } finally {
    await adapter.closeAll()
  }
})
