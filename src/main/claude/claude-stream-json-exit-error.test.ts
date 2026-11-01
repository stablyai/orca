import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { claudeStreamJsonExitError } from './claude-stream-json-exit-error'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { retryableStructuredAgentSessionStart } from '../native-chat/agent-session-wire/structured-agent-session-start-retry'

it('treats the recorded missing-conversation exit as an explained final refusal', () => {
  const frame = JSON.parse(
    readFileSync(
      new URL('./__fixtures__/claude-missing-conversation.jsonl', import.meta.url),
      'utf8'
    )
  )
  const error = claudeStreamJsonExitError(frame.errors[0], {
    code: 1,
    signal: null,
    processless: false
  })
  expect(providerStartupFailureFact(error)).toMatchObject({
    kind: 'savedConversationMissing',
    detail: { text: expect.stringContaining(frame.errors[0]), audience: 'log' }
  })
  expect(retryableStructuredAgentSessionStart(error)).toBe(false)
})
