import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { ClaudeAssistantFailures } from './claude-assistant-failures'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const entry = z.looseObject({ kind: z.string() })
const capturedFrame = z.object({ at: z.number(), frame: z.record(z.string(), z.unknown()) })

async function captureFrames() {
  const capture = await readFile(
    new URL('./__fixtures__/claude-lifecycle-capture-auth-failed.jsonl', import.meta.url),
    'utf8'
  )
  return capture
    .trim()
    .split('\n')
    .flatMap((line) => {
      const value: unknown = JSON.parse(line)
      return entry.parse(value).kind === 'frame' ? [capturedFrame.parse(value)] : []
    })
}

async function replay(account: 'system' | 'managed', removeTypedError = false) {
  const bodies: AgentJournalItemBody[] = []
  const translator = createClaudeJournalTranslator({
    account: () => account,
    sink: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  for (const { at, frame } of await captureFrames()) {
    if (removeTypedError) {
      delete frame.error
    }
    translator.handle({ type: 'message', sessionId: 'session', observedAt: at, message: frame })
  }
  translator.dispose()
  return bodies
}

describe('captured Claude authentication failure', () => {
  it.each(['system', 'managed'] as const)(
    'shows one failure with %s sign-in advice and Claude detail',
    async (account) => {
      const bodies = await replay(account)
      const failures = bodies.flatMap((body) =>
        body.kind === 'status' && body.failure ? [body] : []
      )
      expect(failures).toHaveLength(1)
      expect(failures[0]?.failure).toMatchObject({
        kind: 'notSignedIn',
        account,
        detail: { text: 'Not logged in · Please run /login', audience: 'person' }
      })
      expect(failures[0]?.text).toContain(
        account === 'managed' ? 'Sign in again in Claude Accounts settings.' : 'claude auth login'
      )
      expect(
        bodies.filter((body) => body.kind === 'message' && body.role === 'assistant')
      ).toHaveLength(0)
      expect(
        bodies.flatMap((body) =>
          body.kind === 'status' && body.text.includes('Not logged in') ? [body] : []
        )
      ).toHaveLength(1)
    }
  )
  it('does not infer authentication from result text without the typed assistant error', async () => {
    expect(
      (await replay('system', true)).some(
        (body) => body.kind === 'status' && body.failure?.kind === 'notSignedIn'
      )
    ).toBe(false)
  })

  it.each([
    ['u1', 'u1'],
    [undefined, 'u1'],
    ['u1', undefined],
    [undefined, undefined]
  ])(
    'associates optional send identities %s / %s only until settlement',
    async (assistantId, resultId) => {
      const frames = (await captureFrames()).map(({ frame }) => frame)
      for (const error of ['authentication_failed', 'model_not_found']) {
        const bodies: AgentJournalItemBody[] = []
        const translator = createClaudeJournalTranslator({
          model: () => 'opus[1m]',
          sink: {
            appendItem: (_identity, body) => bodies.push(body),
            appendTombstone: () => {},
            publish: () => {}
          }
        })
        for (const frame of frames) {
          translator.handle({
            type: 'message',
            sessionId: 'session',
            message: {
              ...frame,
              ...(frame.type === 'assistant' ? { error, user_message_uuid: assistantId } : {}),
              ...(frame.type === 'result'
                ? {
                    user_message_uuid: resultId,
                    user_message_uuids: resultId ? [resultId] : undefined
                  }
                : {})
            }
          })
        }
        expect(
          bodies.filter((body) => body.kind === 'status' && body.tone === 'error')
        ).toHaveLength(1)
        translator.handle({
          type: 'message',
          sessionId: 'session',
          message: {
            ...frames.find((frame) => frame.type === 'result'),
            uuid: 'unrelated-result',
            user_message_uuid: 'u2',
            user_message_uuids: ['u2'],
            result: 'API Error: 529 upstream overloaded'
          }
        })
        expect(bodies.at(-1)).toMatchObject({
          kind: 'status',
          text: 'API Error: 529 upstream overloaded'
        })
        translator.dispose()
      }
    }
  )

  it.each(['different send', 'different send list', 'next user', 'successful result'])(
    'does not let a pending failure hide a later error after %s',
    async (boundary) => {
      const frames = (await captureFrames()).map(({ frame }) => frame)
      const bodies: AgentJournalItemBody[] = []
      const translator = createClaudeJournalTranslator({
        sink: {
          appendItem: (_identity, body) => bodies.push(body),
          appendTombstone: () => {},
          publish: () => {}
        }
      })
      const handle = (message: Record<string, unknown>) =>
        translator.handle({ type: 'message', sessionId: 'session', message })
      const assistant = frames.find((frame) => frame.type === 'assistant')!
      const result = frames.find((frame) => frame.type === 'result')!
      handle({ ...assistant, error: 'model_not_found', user_message_uuid: 'u1' })
      if (boundary === 'next user') {
        handle({
          type: 'user',
          uuid: 'u2',
          session_id: assistant.session_id,
          message: { role: 'user', content: [{ type: 'text', text: 'try again' }] }
        })
      }
      handle({
        ...result,
        user_message_uuid: boundary === 'different send' ? 'u2' : undefined,
        user_message_uuids: boundary === 'different send list' ? ['u2'] : undefined,
        is_error: boundary !== 'successful result',
        terminal_reason: boundary === 'successful result' ? 'completed' : 'api_error',
        result: boundary === 'successful result' ? 'ok' : 'API Error: 529 upstream overloaded'
      })
      if (boundary !== 'successful result') {
        expect(bodies.at(-1)).toMatchObject({
          kind: 'status',
          text: 'API Error: 529 upstream overloaded'
        })
      }
      handle({
        ...result,
        uuid: 'later-result',
        user_message_uuid: 'u1',
        user_message_uuids: ['u1'],
        result: 'API Error: 500 later failure'
      })
      expect(bodies.at(-1)).toMatchObject({ kind: 'status', text: 'API Error: 500 later failure' })
      translator.dispose()
    }
  )
})

it('bounds pending result UUID association to two list passes and releases it on settlement', () => {
  for (const size of [64, 640]) {
    const counts = { validation: 0, membership: 0 }
    const numeric = (key: string | symbol) => typeof key === 'string' && /^\d+$/.test(key)
    const uuids = new Proxy(
      Array.from({ length: size }, (_, i) => (i === size - 1 ? 'u1' : `other-${i}`)),
      {
        get(array, key, receiver) {
          if (numeric(key)) {
            counts.validation += 1
            return array[Number(key)]
          }
          if (key === 'filter') {
            return (callback: (value: string, index: number, array: string[]) => unknown) =>
              new Proxy(array.filter.call(receiver, callback), {
                get(filtered, property) {
                  if (numeric(property)) {
                    counts.membership += 1
                    return filtered[Number(property)]
                  }
                  if (property === 'length' || property === 'includes') {
                    return filtered[property]
                  }
                  throw new Error(`Unexpected membership-list property: ${String(property)}`)
                }
              })
          }
          if (key === 'length' || key === 'constructor') {
            return array[key]
          }
          throw new Error(`Unexpected validation-list property: ${String(key)}`)
        }
      }
    )
    for (const outcome of ['match', 'mismatch', 'success']) {
      const failures = new ClaudeAssistantFailures()
      const result = { session_id: 's', is_error: outcome !== 'success', user_message_uuids: uuids }
      counts.validation = counts.membership = 0
      expect(failures.resultAlreadyShown(result)).toBe(false)
      expect(counts).toEqual({ validation: 0, membership: 0 })
      failures.assistant({
        type: 'assistant',
        session_id: 's',
        error: 'model_not_found',
        user_message_uuid: outcome === 'mismatch' ? 'absent' : 'u1',
        message: { content: [] }
      })
      expect(failures.resultAlreadyShown(result)).toBe(outcome === 'match')
      expect(counts.validation).toBeGreaterThanOrEqual(size)
      expect(counts.membership).toBeGreaterThanOrEqual(outcome === 'success' ? 0 : size)
      expect(counts.validation + counts.membership).toBeLessThanOrEqual(2 * size + 1)
      counts.validation = counts.membership = 0
      expect(failures.resultAlreadyShown({ ...result, is_error: true })).toBe(false)
      expect(counts).toEqual({ validation: 0, membership: 0 })
    }
  }
})
