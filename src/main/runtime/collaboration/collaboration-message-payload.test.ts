import { describe, expect, it } from 'vitest'
import {
  encodeCollaborationMessagePayload,
  parseCollaborationMessagePayload,
  type CollaborationMessagePayload
} from './collaboration-message-payload'

const validPayload: CollaborationMessagePayload = {
  version: 1,
  topic: 'agent-status',
  semanticType: 'status.updated',
  producerTaskId: 'task-42'
}

describe('encodeCollaborationMessagePayload', () => {
  it('returns a JSON string with exactly the four contract fields', () => {
    expect(JSON.parse(encodeCollaborationMessagePayload(validPayload))).toEqual(validPayload)
  })
})

describe('parseCollaborationMessagePayload', () => {
  it('round-trips an encoded payload', () => {
    expect(
      parseCollaborationMessagePayload(encodeCollaborationMessagePayload(validPayload))
    ).toEqual(validPayload)
  })

  it('returns null for invalid JSON instead of throwing', () => {
    expect(parseCollaborationMessagePayload('{not json')).toBeNull()
    expect(parseCollaborationMessagePayload('')).toBeNull()
    expect(parseCollaborationMessagePayload('   ')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    for (const json of ['null', '42', '"str"', 'true']) {
      expect(parseCollaborationMessagePayload(json)).toBeNull()
    }
  })

  it('returns null for arrays', () => {
    expect(parseCollaborationMessagePayload('[]')).toBeNull()
    expect(parseCollaborationMessagePayload('[{"version":1}]')).toBeNull()
  })

  it('returns null for a foreign or mistyped version', () => {
    expect(
      parseCollaborationMessagePayload(JSON.stringify({ ...validPayload, version: 2 }))
    ).toBeNull()
    expect(
      parseCollaborationMessagePayload(JSON.stringify({ ...validPayload, version: '1' }))
    ).toBeNull()
  })

  it('returns null when any required field is missing', () => {
    for (const key of ['topic', 'semanticType', 'producerTaskId'] as const) {
      const { [key]: _omitted, ...rest } = validPayload
      expect(parseCollaborationMessagePayload(JSON.stringify(rest))).toBeNull()
    }
    expect(
      parseCollaborationMessagePayload(JSON.stringify({ topic: 't', semanticType: 's' }))
    ).toBeNull()
  })

  it('returns null when a field is not a string', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['topic', 5],
      ['topic', null],
      ['topic', {}],
      ['semanticType', 5],
      ['semanticType', ['x']],
      ['producerTaskId', false]
    ]
    for (const [key, value] of cases) {
      expect(
        parseCollaborationMessagePayload(JSON.stringify({ ...validPayload, [key]: value }))
      ).toBeNull()
    }
  })

  it('preserves opaque topic/semanticType strings without trimming or normalization', () => {
    const opaque = { ...validPayload, topic: '  Topic With Spaces  ', semanticType: '  a.b  ' }
    expect(parseCollaborationMessagePayload(encodeCollaborationMessagePayload(opaque))).toEqual(
      opaque
    )
  })

  it('ignores extra fields not in the contract', () => {
    const withExtra = { ...validPayload, body: 'ignored', priority: 3 }
    expect(parseCollaborationMessagePayload(JSON.stringify(withExtra))).toEqual(validPayload)
  })
})
