import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexTransientTurnFailures } from './codex-structured-turn-end-settlement'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'
import {
  acquireReadyCodexForTest,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import type { StructuredAgentSessionTransition } from '../native-chat/agent-session-wire/structured-agent-session-transition'

const frames: { case: string; method: string; params: Record<string, unknown> }[] = readFileSync(
  join(__dirname, '__fixtures__/codex-app-server-turn-endings.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

it('carries exact-turn recorded stream-disconnect evidence and lets an explicit unauthorized final win', () => {
  const recorded = frames.filter((frame) => frame.case === '0.158.0-stream-drop')
  const classifier = new CodexTransientTurnFailures()
  const categories = recorded
    .map((frame) => classifier.observe(frame.method, frame.params))
    .filter(Boolean)
  expect(categories).toEqual(['stream-disconnected'])
  const final = recorded.find((frame) => frame.method === 'turn/completed')!
  for (const frame of recorded.filter((frame) => frame.method !== 'turn/completed')) {
    classifier.observe(frame.method, frame.params)
  }
  // Change only the final typed code to exercise precedence over the recorded retry evidence.
  const params = structuredClone(final.params)
  Object.assign(params, {
    turn: {
      id: readCodexTurnId(params),
      status: 'failed',
      error: { codexErrorInfo: 'unauthorized', message: 'Not authorized' }
    }
  })
  expect(classifier.observe(final.method, params)).toBeUndefined()
})

it('does not attach retry eligibility to the recorded compact command failure', () => {
  const recorded = frames.filter((frame) => frame.case === '0.158.0-compact-overloaded')
  const failed = recorded.find(
    (frame) => frame.method === 'turn/completed' && JSON.stringify(frame.params).includes('failed')
  )!
  const failedId = readCodexTurnId(failed.params)
  const thread = readCodexThreadId(failed.params)!
  const transitions: StructuredAgentSessionTransition[] = []
  const translator = createCodexJournalTranslator({
    sessionId: 'session-1',
    primaryThreadId: () => thread,
    sink: {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      tryAppendTransition: (transition) => {
        transitions.push(transition)
        return { accepted: true }
      }
    }
  })
  for (const frame of recorded) {
    if (frame.method === 'turn/started' && readCodexTurnId(frame.params) === failedId) {
      translator.beginCommand({
        clientMessageId: 'compact-1',
        turnId: 'compact:compact-1',
        identity: { provider: 'orca', clientMessageId: 'command-turn:compact-1' },
        resultIdentity: { provider: 'orca', clientMessageId: 'command-result:compact-1' },
        running: { kind: 'turn', turnId: 'compact:compact-1', state: 'running' }
      })
    }
    translator.handle({
      type: 'notification',
      sessionId: 'session-1',
      threadId: thread,
      method: frame.method,
      params: frame.params
    })
  }
  expect(transitions.every((transition) => transition.transientTerminal === undefined)).toBe(true)
})

it('starts a hidden Codex continuation with empty input and captured root options', async () => {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'retry-1')
  const adapter = adapterFor(codex)
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'retry-test'
    })
    expect(
      await adapter.continueAfterTransientFailure({
        sessionId: 'session-1',
        fence: 7,
        options: { model: 'gpt-live', effort: 'medium' },
        admitFreshInput: async (enqueue) => enqueue('ask', false),
        signal: new AbortController().signal
      })
    ).toEqual({ state: 'started', providerTurnRef: 'retry-1' })
    const request = codex.connections[0].calls.find((call) => call.method === 'turn/start')!
    expect(request.params).toMatchObject({ input: [], model: 'gpt-live', effort: 'medium' })
    expect(request.params).not.toHaveProperty('clientUserMessageId')
  } finally {
    await adapter.closeAll()
  }
})
