import { describe, expect, it } from 'vitest'
import { askView } from './ask-agent-view'

describe('a waiting ask told its question went unanswered', () => {
  it('shows the notice, not a cancelled wait', () => {
    const view = askView({ from: 'term_w', dispatchCapability: undefined, timeoutMs: 60_000 })
    const result = {
      answer: null,
      messageId: 'msg_q',
      threadId: 'msg_q',
      timedOut: false,
      cancelled: false,
      connectionLost: false,
      told: 'unanswered' as const,
      notice: 'Decide it yourself.'
    }
    const fields = view.fields(result)

    expect(fields).toMatchObject({ told: 'unanswered', notice: 'Decide it yourself.' })
    expect(view.text?.(fields, result)).toBe('Decide it yourself.')
    expect(view.failure?.(result)).toBeUndefined()
  })
})
