import { expect, it } from 'vitest'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import {
  ZcodeChatSession,
  zcodeTurnArgs,
  type ZcodeStartTurn,
  type ZcodeTurnHandle
} from './zcode-chat-session'
import type { ZcodeStreamRecord } from './zcode-stream-records'

type FakeScript = (
  record: (value: ZcodeStreamRecord) => void,
  done: (completion: { sessionId: string | null; response: string | null }) => void,
  fail: (error: Error) => void
) => void

function fakeTurn(script: FakeScript) {
  const launches: ProviderProcessLaunch[] = []
  const start: ZcodeStartTurn = (launch, onRecord) => {
    launches.push(launch)
    const completion = Promise.withResolvers<{
      sessionId: string | null
      response: string | null
    }>()
    // Records arrive after `submit` returns, like a real child's stdout, so `turn.open` lands first.
    queueMicrotask(() =>
      script(
        onRecord,
        (value) => completion.resolve(value),
        (error) => completion.reject(error)
      )
    )
    const handle: ZcodeTurnHandle = { done: completion.promise, abort: () => {} }
    return handle
  }
  return { start, launches }
}

it('maps the provider CLI arguments, keeping resume and option picks', () => {
  expect(zcodeTurnArgs({ prompt: 'hi', cwd: '/w' })).toEqual([
    '-p',
    'hi',
    '--output-format',
    'stream-json',
    '--cwd',
    '/w'
  ])
  expect(
    zcodeTurnArgs({
      prompt: 'again',
      cwd: '/w',
      prefixArgs: ['/bin/zcode'],
      resumeId: 'sess_1',
      model: 'GLM-5.3-Flash',
      effort: 'max'
    })
  ).toEqual([
    '/bin/zcode',
    '-p',
    'again',
    '--output-format',
    'stream-json',
    '--cwd',
    '/w',
    '--resume',
    'sess_1',
    '--model',
    'GLM-5.3-Flash',
    '--effort',
    'max'
  ])
})

it('runs a turn, keeps the provider session id, and resumes it on the next turn', async () => {
  const events: ProviderTimelineEvent[] = []
  const settled: string[] = []
  let turnEnded = Promise.withResolvers<void>()
  const { start, launches } = fakeTurn((record, done) => {
    record({ type: 'turn.started', sessionId: 'sess_x' })
    record({
      type: 'model.streaming',
      sessionId: 'sess_x',
      payload: { kind: 'text_delta', delta: 'OK' }
    })
    done({ sessionId: 'sess_x', response: 'OK' })
  })
  const session = new ZcodeChatSession(
    { command: 'zcode', prefixArgs: [], cwd: '/w' },
    {
      onEvents: (batch) => {
        events.push(...batch)
        if (batch.some((event) => event.type === 'turn.end')) {
          turnEnded.resolve()
        }
      },
      onTurnSettled: ({ clientMessageId }) => settled.push(clientMessageId),
      onProviderSessionId: () => {},
      onError: () => {}
    },
    null,
    start
  )

  expect(
    await session.submit({ clientMessageId: 'm1', prompt: 'reply with exactly OK', requestedAt: 1 })
  ).toEqual({ state: 'admitted' })
  await turnEnded.promise
  turnEnded = Promise.withResolvers<void>()
  expect(session.resumeId).toBe('sess_x')
  expect(launches[0]?.args).not.toContain('--resume')

  expect(await session.submit({ clientMessageId: 'm2', prompt: 'again', requestedAt: 2 })).toEqual({
    state: 'admitted'
  })
  await turnEnded.promise
  expect(launches[1]?.args).toEqual(expect.arrayContaining(['--resume', 'sess_x']))
  const assistantText = events
    .filter((event) => event.type === 'text.delta' && event.channel === 'assistant')
    .map((event) => ('text' in event ? event.text : ''))
    .join('')
  expect(assistantText).toBe('OKOK')
  expect(settled).toEqual([])
})

it('reports an incomplete turn (exit without a result record) as unsettled', async () => {
  const events: ProviderTimelineEvent[] = []
  const settled: { clientMessageId: string; reason: string }[] = []
  const turnSettled = Promise.withResolvers<void>()
  const { start } = fakeTurn((record, _done, fail) => {
    record({ type: 'turn.started', sessionId: 'sess_y' })
    record({
      type: 'model.streaming',
      sessionId: 'sess_y',
      payload: { kind: 'text_delta', delta: 'hi' }
    })
    fail(new Error('ZCode exited 0 without a terminal result record'))
  })
  const session = new ZcodeChatSession(
    { command: 'zcode', prefixArgs: [], cwd: '/w' },
    {
      onEvents: (batch) => events.push(...batch),
      onTurnSettled: ({ clientMessageId, outcome }) => {
        settled.push({
          clientMessageId,
          reason: outcome.state === 'unknown' ? outcome.reason : outcome.state
        })
        turnSettled.resolve()
      },
      onProviderSessionId: () => {},
      onError: () => {}
    },
    null,
    start
  )
  await session.submit({ clientMessageId: 'm1', prompt: 'NO-RESULT', requestedAt: 1 })
  await turnSettled.promise
  expect(settled).toEqual([
    { clientMessageId: 'm1', reason: 'ZCode exited 0 without a terminal result record' }
  ])
  expect(events.find((event) => event.type === 'turn.end')).toEqual({
    type: 'turn.end',
    turn: 'zcode-turn-1',
    at: expect.any(Number),
    state: 'interrupted'
  })
})
