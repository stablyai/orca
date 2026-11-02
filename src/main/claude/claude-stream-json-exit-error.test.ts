import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  claudeStartupResultError,
  claudeStreamJsonExitError
} from './claude-stream-json-exit-error'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { retryableStructuredAgentSessionStart } from '../native-chat/agent-session-wire/structured-agent-session-start-retry'

const frame = JSON.parse(
  readFileSync(new URL('./__fixtures__/claude-missing-conversation.jsonl', import.meta.url), 'utf8')
)

it('treats the recorded missing-conversation exit as an explained final refusal', () => {
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

it('reads the same refusal from the recorded result, and makes other startup results final', () => {
  const refusal = claudeStartupResultError(frame)
  expect(providerStartupFailureFact(refusal)).toEqual({
    kind: 'savedConversationMissing',
    detail: { text: frame.errors[0], audience: 'log' }
  })
  expect(retryableStructuredAgentSessionStart(refusal)).toBe(false)
  const generic = claudeStartupResultError({ ...frame, errors: ['managed settings failed'] })
  expect(providerStartupFailureFact(generic)).toMatchObject({
    kind: 'startFailed',
    detail: { text: 'managed settings failed', audience: 'log' }
  })
  expect(retryableStructuredAgentSessionStart(generic)).toBe(false)
})
