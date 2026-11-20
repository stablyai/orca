import { expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

const chunk = (text: string) => ({
  sessionId: 's',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})

it("fails a turn only on agy's own failure line, not on a reply that quotes one", () => {
  const notice = (text: string) =>
    ANTIGRAVITY_ACP_DIALECT.notification?.('session/update', chunk(text), 0)
  expect(notice('\n⚠ agent executor error: generating and executing: Error 400\n')).toMatchObject({
    failure: { stopReason: 'error' }
  })
  expect(notice('The log said ⚠ agent executor error: something')).toBeUndefined()
  expect(notice('⚠ agent executor error: one\nand a second line')).toBeUndefined()
})
