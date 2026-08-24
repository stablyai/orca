import { describe, expect, it } from 'vitest'
import { formatRemoteOrchestrationAsk } from './ssh-remote-orchestration-ask-output'

describe('formatRemoteOrchestrationAsk', () => {
  it('includes outcome/pending on timed-out --json results', () => {
    const formatted = formatRemoteOrchestrationAsk(
      {
        ok: true,
        result: {
          answer: null,
          timedOut: true,
          cancelled: false,
          messageId: 'msg_1',
          threadId: 'thread_1',
          timeoutMs: 1000
        }
      },
      true
    )
    const payload = JSON.parse(formatted.stdout) as {
      outcome: string
      pending: boolean
      timedOut: boolean
    }
    expect(payload.outcome).toBe('timed_out_pending')
    expect(payload.pending).toBe(true)
    expect(payload.timedOut).toBe(true)
  })
})
