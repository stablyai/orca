import { describe, expect, it } from 'vitest'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'
import { antigravityExecutorErrorWords } from './antigravity-executor-error'

const KEY_DETAILS =
  '[map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[service:generativelanguage.googleapis.com] reason:API_KEY_INVALID] map[@type:type.googleapis.com/google.rpc.LocalizedMessage locale:en-US message:API key not valid. Please pass a valid API key.]]'
// agy 1.5.5's line for a rejected Gemini API key, as a real chat received it.
const KEY_REJECTED = `⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: ${KEY_DETAILS}`

describe('antigravityExecutorErrorWords', () => {
  it("leads a rejected key with Google's sentence and keeps the whole line, broken at Status and Details", () => {
    expect(antigravityExecutorErrorWords(KEY_REJECTED)).toEqual({
      failureDetail: 'Google rejected the API key: API key not valid. Please pass a valid API key.',
      failureFrame: [
        '⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key.',
        'Status: INVALID_ARGUMENT',
        `Details: ${KEY_DETAILS}`
      ].join('\n')
    })
  })

  it('reads any Google API error the same way, with or without details', () => {
    expect(
      antigravityExecutorErrorWords(
        '⚠ agent executor error: generating and executing: Error 500, Message: The service is currently unavailable., Status: UNAVAILABLE, Details: []'
      )
    ).toEqual({
      failureDetail: 'Google returned an error: The service is currently unavailable.',
      failureFrame:
        '⚠ agent executor error: generating and executing: Error 500, Message: The service is currently unavailable.\nStatus: UNAVAILABLE\nDetails: []'
    })
    expect(
      antigravityExecutorErrorWords(
        '⚠ agent executor error: generating and executing: Error 401, Message: , Status: UNAUTHENTICATED'
      )
    ).toEqual({
      failureDetail: 'Google returned error 401 (UNAUTHENTICATED).',
      failureFrame:
        '⚠ agent executor error: generating and executing: Error 401, Message: \nStatus: UNAUTHENTICATED'
    })
  })

  it('names the key only when Google gives a key reason', () => {
    const consumer =
      "\u26a0 agent executor error: generating and executing: Error 403, Message: Method doesn't allow unregistered callers. Please use API Key or other form of API consumer identity to call this API., Status: PERMISSION_DENIED, Details: []"
    expect(antigravityExecutorErrorWords(consumer)?.failureDetail).toBe(
      "Google returned an error: Method doesn't allow unregistered callers. Please use API Key or other form of API consumer identity to call this API."
    )
    const expired = KEY_REJECTED.replace('API_KEY_INVALID', 'API_KEY_EXPIRED')
    expect(antigravityExecutorErrorWords(expired)?.failureDetail).toMatch(
      /^Google rejected the API key: /
    )
  })

  it('keeps a very long line as it is rather than parsing it', () => {
    const long = `\u26a0 agent executor error: ${'Error 400, Message: , Status: A, '.repeat(2_000)}Status: B`
    const started = performance.now()
    expect(antigravityExecutorErrorWords(long)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('leaves lines without that shape to the notice itself', () => {
    expect(
      antigravityExecutorErrorWords(
        '⚠ agent executor error: failed to create Gemini client: failed to find default credentials'
      )
    ).toBeUndefined()
    expect(antigravityExecutorErrorWords('API key not valid. Please pass a valid API key.')).toBe(
      undefined
    )
  })
})

describe('Antigravity failed-turn row for a Google API error', () => {
  const failedRow = (text: string) => {
    const lane = new AcpTimelineTranslator({
      sessionId: 'root',
      dialect: ANTIGRAVITY_ACP_DIALECT,
      agentName: 'Antigravity'
    })
    lane.openPrompt('prompt-1', 1)
    return lane
      .notification(
        'session/update',
        {
          sessionId: 'root',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
        },
        2
      )
      .flatMap((event) =>
        event.type === 'item.update' && event.body.kind === 'status' ? [event.body] : []
      )
  }

  it("shows Google's sentence with the agent's whole line under Details", () => {
    const [row] = failedRow(`${KEY_REJECTED}\n`)
    expect(row).toMatchObject({
      tone: 'error',
      text: 'Google rejected the API key: API key not valid. Please pass a valid API key.',
      providerFrame: {
        provider: 'Antigravity',
        kind: 'failure-notice',
        payload: {
          head: expect.stringContaining('\nStatus: INVALID_ARGUMENT\nDetails: [map['),
          truncated: false
        }
      }
    })
  })

  it('keeps other failure notices as they were, with no Details', () => {
    const notice =
      '⚠ agent executor error: failed to create Gemini client: failed to find default credentials'
    const [row] = failedRow(notice)
    expect(row?.text).toBe(notice)
    expect(row && 'providerFrame' in row && row.providerFrame).toBeFalsy()
  })
})
