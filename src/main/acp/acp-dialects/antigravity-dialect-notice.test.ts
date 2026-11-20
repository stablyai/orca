import { expect, it } from 'vitest'
import { AcpAgentError } from '../transport/acp-errors'
import { ANTIGRAVITY_ACP_DIALECT, ANTIGRAVITY_ORCA_HOME_ACP_DIALECT } from './antigravity-dialect'

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

it("names each method's fix when agy on Orca's chat home can't sign in, and leaves agy's own home alone", () => {
  const authRequired = new AcpAgentError(-32000, 'Authentication required')
  expect(ANTIGRAVITY_ORCA_HOME_ACP_DIALECT.promptErrorDetail?.(authRequired)).toBe(
    "agy couldn't sign in with this chat's sign-in method. With Google, sign agy in under Settings → Accounts → Antigravity; with gcloud, run `gcloud auth application-default login`; with a Gemini API key, check the key there."
  )
  expect(ANTIGRAVITY_ACP_DIALECT.promptErrorDetail?.(authRequired)).toBeUndefined()
})
