import { describe, expect, it } from 'vitest'
import {
  normalizeMemoryTags,
  parseAgentMemory,
  renderAgentMemory,
  searchAgentMemories,
  type AgentMemoryRecord
} from './agent-memory-record'

function record(overrides: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord {
  return {
    id: 'mem_20260726T120000Z_auth-boundary_a1b2c3d4',
    title: 'Authentication boundary',
    kind: 'decision',
    confidence: 'high',
    createdAt: '2026-07-26T12:00:00.000Z',
    sources: ['docs/security.md'],
    tags: ['auth'],
    body: 'Access tokens stay in the host keychain.',
    ...overrides
  }
}

describe('agent memory records', () => {
  it('round-trips cited Markdown records', () => {
    const original = record({
      supersedes: 'mem_20260725T120000Z_old-boundary_deadbeef'
    })

    const markdown = renderAgentMemory(original)

    expect(parseAgentMemory(markdown, 'entry.md')).toEqual(original)
    expect(markdown).toContain('schema: orca.agent-memory/v1')
    expect(markdown).toContain('sources:')
  })

  it('rejects uncited or empty records', () => {
    const markdown = renderAgentMemory(record())

    expect(() =>
      parseAgentMemory(
        markdown.replace('sources:\n  - docs/security.md\n', 'sources: []\n'),
        'entry.md'
      )
    ).toThrow('at least one sources value')
    expect(() =>
      parseAgentMemory(markdown.replace('Access tokens stay in the host keychain.', ''), 'entry.md')
    ).toThrow('empty body')
  })

  it('normalizes and deduplicates retrieval tags', () => {
    expect(normalizeMemoryTags(['Auth', 'build.v2', 'Auth'])).toEqual(['auth', 'build.v2'])
    expect(() => normalizeMemoryTags(['not allowed'])).toThrow('Invalid memory tag')
  })

  it('ranks title matches ahead of body-only matches', () => {
    const matches = searchAgentMemories(
      [
        record(),
        record({
          id: 'mem_20260726T130000Z_build-note_b1c2d3e4',
          title: 'Build note',
          body: 'The authentication boundary is verified by integration tests.'
        })
      ],
      'authentication boundary',
      { includeSuperseded: false, limit: 8 }
    )

    expect(matches.map((match) => match.record.title)).toEqual([
      'Authentication boundary',
      'Build note'
    ])
    expect(matches[0].citation).toBe('[memory:mem_20260726T120000Z_auth-boundary_a1b2c3d4]')
  })

  it('hides superseded records unless history is requested', () => {
    const oldRecord = record()
    const newRecord = record({
      id: 'mem_20260727T120000Z_auth-boundary-v2_b1c2d3e4',
      title: 'Authentication boundary v2',
      createdAt: '2026-07-27T12:00:00.000Z',
      supersedes: oldRecord.id
    })

    expect(
      searchAgentMemories([oldRecord, newRecord], 'authentication', {
        includeSuperseded: false,
        limit: 8
      }).map((match) => match.record.id)
    ).toEqual([newRecord.id])
    expect(
      searchAgentMemories([oldRecord, newRecord], 'authentication', {
        includeSuperseded: true,
        limit: 8
      }).map((match) => match.record.id)
    ).toEqual([newRecord.id, oldRecord.id])
  })

  it('preserves concurrent supersession branches', () => {
    const oldRecord = record()
    const successors = [
      record({
        id: 'mem_20260727T120000Z_auth-boundary-v2_b1c2d3e4',
        title: 'Authentication boundary v2',
        supersedes: oldRecord.id
      }),
      record({
        id: 'mem_20260727T130000Z_auth-boundary-alt_c1d2e3f4',
        title: 'Authentication boundary alternative',
        supersedes: oldRecord.id
      })
    ]

    const oldMatch = searchAgentMemories([oldRecord, ...successors], 'authentication', {
      includeSuperseded: true,
      limit: 8
    }).find((match) => match.record.id === oldRecord.id)

    expect(oldMatch?.supersededBy).toEqual(successors.map((successor) => successor.id).sort())
  })

  it('filters retrieval by kind and tag', () => {
    const matches = searchAgentMemories(
      [
        record(),
        record({
          id: 'mem_20260727T120000Z_auth-lesson_b1c2d3e4',
          title: 'Authentication lesson',
          kind: 'lesson',
          tags: ['incident']
        })
      ],
      'authentication',
      { includeSuperseded: false, limit: 8, kind: 'lesson', tag: 'incident' }
    )

    expect(matches.map((match) => match.record.kind)).toEqual(['lesson'])
  })
})
