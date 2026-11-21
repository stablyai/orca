import { expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

const chunk = (text: string) => ({
  sessionId: 's',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})
const notice = (text: string) =>
  ANTIGRAVITY_ACP_DIALECT.notification?.('session/update', chunk(text), 0)

it("fails a turn on agy's executor-error line (agy 1.5.13 on a rejected Gemini API key)", () => {
  expect(
    notice(
      '\n⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT\n'
    )
  ).toMatchObject({ failure: { stopReason: 'error' } })
})

it('leaves a reply that only quotes the line, or says more after it, as the answer', () => {
  expect(notice('The log said ⚠ agent executor error: something')).toBeUndefined()
  expect(notice('⚠ agent executor error: one\nand a second line')).toBeUndefined()
})
