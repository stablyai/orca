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

// agy 1.5.2 sends this when it drops a session whose agent it cannot rebuild, with the reason after.
const REBUILD_FAILED =
  'Agent connection was lost and could not be re-established: Failed to rebuild agent: '

it.each([
  'Harness process exited with code -9.\nHarness stderr:\npanic: boom\n',
  'Failed to connect to WebSocket at ws://127.0.0.1:1/ws. Stderr: bind failed'
])("fails a turn on agy's notice that it could not rebuild its agent: %s", (reason) => {
  expect(notice(`${REBUILD_FAILED}${reason}`)).toMatchObject({ failure: { stopReason: 'error' } })
})

it('leaves a reply that only quotes the rebuild notice as the answer', () => {
  expect(
    notice(`You pasted "${REBUILD_FAILED}Harness process exited with code 1."`)
  ).toBeUndefined()
})
