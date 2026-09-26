import { describe, expect, it } from 'vitest'
import { formatRemoteOrchestrationAsk } from './ssh-remote-orchestration-ask-output'

describe('formatRemoteOrchestrationAsk', () => {
  it('includes outcome/pending on timed-out --json results', () => {
    const formatted = formatRemoteOrchestrationAsk(
      {
        id: 'req_ask',
        ok: true,
        result: {
          answer: null,
          timedOut: true,
          cancelled: false,
          messageId: 'msg_1',
          threadId: 'thread_1',
          timeoutMs: 1000
        },
        _meta: { runtimeId: 'runtime-test' }
      },
      true
    )
    const payload = JSON.parse(formatted.stdout)
    expect(payload).toMatchObject({
      outcome: 'timed_out_pending',
      pending: true,
      timedOut: true
    })
  })
})
