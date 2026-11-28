import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  isZcodeResultRecord,
  parseZcodeStreamRecord,
  zcodeRecordSessionId
} from './zcode-stream-records'
import { ZcodeTimelineTranslator } from './zcode-timeline'

const FIXTURE = new URL('./fixtures/zcode-reply-ok.jsonl', import.meta.url)

function fixtureRecords() {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .map(parseZcodeStreamRecord)
    .filter((record) => record !== null)
}

it('reads the captured `reply with exactly OK` stream-json run', () => {
  const records = fixtureRecords()
  const result = records.find(isZcodeResultRecord)
  expect(result?.response).toBe('OK')
  expect(zcodeRecordSessionId(result!)).toBe('sess_aef4117a-8375-43a6-a437-265b8868d9a6')

  const translator = new ZcodeTimelineTranslator()
  const events: ProviderTimelineEvent[] = [
    ...translator.beginTurn({ clientMessageId: 'm1', requestedAt: 1, turnId: 't1' })
  ]
  for (const record of records) {
    events.push(...(translator.frame(record) ?? []))
  }
  events.push(
    ...translator.finish({
      turnId: 't1',
      at: 2,
      response: result?.response ?? null,
      interrupted: false
    })
  )

  const assistantText = events
    .filter((event) => event.type === 'text.delta' && event.channel === 'assistant')
    .map((event) => ('text' in event ? event.text : ''))
    .join('')
  expect(assistantText).toBe('OK')
  expect(events.some((event) => event.type === 'turn.open')).toBe(true)
  expect(events.filter((event) => event.type === 'turn.end')).toEqual([
    { type: 'turn.end', turn: 't1', at: 2, state: 'completed', outcome: 'success' }
  ])
})

it('binds turn open before the send it started', () => {
  const events = new ZcodeTimelineTranslator().beginTurn({
    clientMessageId: 'm1',
    requestedAt: 7,
    turnId: 't1'
  })
  expect(events).toEqual([
    { type: 'turn.open', turn: 't1', at: 7 },
    { type: 'input.accepted', clientMessageId: 'm1', requestedAt: 7, join: { turn: 't1' } }
  ])
})

it('drops blank and torn lines instead of failing the stream', () => {
  expect(parseZcodeStreamRecord('')).toBeNull()
  expect(parseZcodeStreamRecord('   ')).toBeNull()
  expect(parseZcodeStreamRecord('{"type":')).toBeNull()
  expect(parseZcodeStreamRecord('{"type":"turn.started"}')).toEqual({ type: 'turn.started' })
})

it('does not mistake a mid-stream record for the terminal result', () => {
  expect(isZcodeResultRecord({ type: 'turn.completed', payload: { response: 'OK' } })).toBe(false)
  expect(isZcodeResultRecord({ type: 'result', response: 'OK' })).toBe(true)
})

it('reports a tool record as a one-line activity row', () => {
  const events = new ZcodeTimelineTranslator().frame({
    type: 'tool.completed',
    payload: { toolName: 'Bash' }
  })
  expect(events).toEqual([{ type: 'activity', text: 'Ran Bash' }])
})

it('seals reasoning and assistant text before ending the turn', () => {
  const translator = new ZcodeTimelineTranslator()
  translator.beginTurn({ clientMessageId: 'm1', requestedAt: 1, turnId: 't1' })
  translator.frame({ type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: 'hi' } })
  translator.frame({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'OK' } })
  const sealed = translator.finish({ turnId: 't1', at: 5, response: 'OK', interrupted: false })
  expect(sealed).toEqual([
    { type: 'text.close', item: { stream: 'reasoning' }, join: { turn: 't1' } },
    { type: 'text.close', item: { stream: 'assistant' }, join: { turn: 't1' }, text: 'OK' },
    { type: 'turn.end', turn: 't1', at: 5, state: 'completed', outcome: 'success' }
  ])
})

it('ends an interrupted turn without a provider outcome', () => {
  const translator = new ZcodeTimelineTranslator()
  translator.beginTurn({ clientMessageId: 'm1', requestedAt: 1, turnId: 't1' })
  expect(translator.finish({ turnId: 't1', at: 9, response: null, interrupted: true })).toEqual([
    { type: 'turn.end', turn: 't1', at: 9, state: 'interrupted' }
  ])
})
