import { afterEach, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  sessionId as piSessionId,
  setup as setupPi
} from '../pi/rpc-session-adapter.test-fixture'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

let closeFixtures: () => Promise<void>
afterEach(() => closeFixtures())

it.each(['Pi', 'OMP'])(
  'names %s in prompt rejections and failed response rows',
  async (agentName) => {
    closeFixtures = agentName === 'OMP' ? closeOmpRpcAdapterFixtures : closePiRpcAdapterFixtures
    const h = agentName === 'OMP' ? await setupOmpRpcAdapter() : await setupPi()
    const sessionId = agentName === 'OMP' ? 'omp-test' : piSessionId
    const fence = agentName === 'OMP' ? 1 : 7
    const detail =
      '503 Service temporarily unavailable\nService temporarily unavailable (type=api_error).'
    await h.adapter.dispatch({
      sessionId,
      fence,
      clientMessageId: 'rejected-message',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
    h.connection.receive({
      type: 'response',
      command: 'prompt',
      promptId: h.connection.sent.at(-1)?.id,
      success: false,
      error: detail
    })
    expect(h.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: 'rejected-message',
        outcome: expect.objectContaining({
          state: 'rejected',
          reason: `${agentName} didn't accept this message: ${detail}`
        })
      })
    )

    h.connection.receive({ type: 'agent_start' })
    h.connection.receive({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: detail }
    })
    h.connection.receive({ type: 'agent_settled' })
    await vi.waitFor(async () => {
      const errors = (await h.rig.rows()).flatMap(({ body }) =>
        body.kind === 'status' && body.failure ? [body] : []
      )
      expect(errors).toHaveLength(1)
      expect(errors[0]?.text).toBe(`${agentName} didn't accept this message: ${detail}`)
    })
  }
)
