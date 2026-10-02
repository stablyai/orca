import { expect, it } from 'vitest'
import { EMPTY_ROOM_CONTEXT } from '../../../shared/rooms'
import { participantFromRow } from './rows'
import {
  parseRoomJson,
  roomContextSchema,
  roomMetadataSchema,
  roomProviderSessionSchema
} from './row-json'

it('preserves older partial context, machine identity and unknown persisted fields', () => {
  const providerSession = {
    key: 'session_id',
    id: 'saved',
    transport: 'machine',
    transcriptPath: '/host/session.jsonl',
    futureField: true
  }
  const participant = participantFromRow({
    actor_kind: 'agent',
    agent: 'codex',
    state: 'sleeping',
    provider_session_json: JSON.stringify(providerSession),
    context_json: JSON.stringify({ model: 'saved-model', effort: 'high', futureField: true })
  })
  expect(participant.providerSession).toEqual(providerSession)
  expect(participant.context).toEqual({
    ...EMPTY_ROOM_CONTEXT,
    model: 'saved-model',
    effort: 'high',
    futureField: true
  })
  expect(parseRoomJson('{"nested":{"items":[1]}}', roomMetadataSchema, {})).toEqual({
    nested: { items: [1] }
  })
})

it('falls back on corrupt JSON or incompatible known fields', () => {
  expect(parseRoomJson('{', roomContextSchema, {})).toEqual({})
  expect(parseRoomJson('{"model":42}', roomContextSchema, {})).toEqual({})
  expect(parseRoomJson('{"id":"missing-key"}', roomProviderSessionSchema, null)).toBeNull()
  expect(parseRoomJson(null, roomProviderSessionSchema, null)).toBeNull()
})
