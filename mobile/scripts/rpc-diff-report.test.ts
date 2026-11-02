import { describe, expect, it } from 'vitest'
import { diffGoldenSets, formatChangeMarkdown, formatChangeText } from './rpc-diff-report'
import {
  decodeGoldenFile,
  type DecodedGolden
} from '../src/test-support/rpc-recording/golden-difference'
import { internRecording } from '../src/test-support/rpc-recording/golden-value-pool'
import type { Recording } from '../src/test-support/rpc-recording/recording-scenario'
import type { RecordedValue } from '../src/test-support/rpc-recording/recording-values'

function checkpoint(id: string, sender: RecordedValue[], state: RecordedValue = null) {
  return { id, observation: { sender, payloads: [], settlements: {}, state, effects: [] } }
}
function golden(recording: Recording, family = 'fam'): DecodedGolden {
  return { operation: 'op', family, namedDeltas: [], recording }
}
const sent = (method: string) => ({ name: `${method}#1`, method })

describe('golden change report', () => {
  it('pairs a repeated checkpoint id by occurrence, not by its last appearance', () => {
    const recording: Recording = {
      scenario: 's',
      checkpoints: [checkpoint('load', [sent('a')]), checkpoint('load', [sent('a'), sent('b')])]
    }
    const set = diffGoldenSets(
      'base',
      new Map([['g', golden(recording)]]),
      new Map([['g', golden(recording)]])
    )
    expect(set.changed).toEqual([])
  })

  it('groups one moved entry across the checkpoints that re-state it', () => {
    const before: Recording = {
      scenario: 's',
      checkpoints: [checkpoint('one', [sent('a')]), checkpoint('two', [sent('a'), sent('c')])]
    }
    const after: Recording = {
      scenario: 's',
      checkpoints: [checkpoint('one', [sent('b')]), checkpoint('two', [sent('b'), sent('c')])]
    }
    const set = diffGoldenSets(
      'base',
      new Map([['g', golden(before)]]),
      new Map([['g', golden(after)]])
    )
    expect(set.changed).toHaveLength(1)
    expect(set.changed[0]!.differences).toEqual([
      {
        field: 'sender',
        path: '[0].method',
        expected: 'a',
        actual: 'b',
        checkpoints: ['one', 'two']
      }
    ])
    expect(formatChangeText(set)).toContain(
      'checkpoint one field sender[0].method (and 1 later checkpoint)'
    )
  })

  it('names identity, checkpoint-list, added and removed changes', () => {
    const recording: Recording = { scenario: 's', checkpoints: [checkpoint('one', [])] }
    const moved: Recording = { scenario: 's', checkpoints: [checkpoint('two', [])] }
    const set = diffGoldenSets(
      'base',
      new Map([
        ['kept', golden(recording)],
        ['gone', golden(recording)]
      ]),
      new Map([
        ['kept', { ...golden(moved), family: 'other' }],
        ['new', golden(recording)]
      ])
    )
    const text = formatChangeText(set)
    expect(text).toContain('family: "fam" -> "other"')
    expect(text).toContain('checkpoints no longer recorded: one')
    expect(text).toContain('checkpoints newly recorded: two')
    expect(set.added).toEqual([{ id: 'new', family: 'fam' }])
    expect(set.removed).toEqual([{ id: 'gone', family: 'fam' }])
    expect(formatChangeMarkdown(set)).toContain('### Removed goldens (1)')
  })

  it('stops details at the byte cap and still names every changed golden', () => {
    const big = 'x'.repeat(2_000)
    const before = new Map<string, DecodedGolden>()
    const after = new Map<string, DecodedGolden>()
    for (let index = 0; index < 200; index += 1) {
      const id = `g${String(index).padStart(3, '0')}`
      before.set(id, golden({ scenario: id, checkpoints: [checkpoint('c', [], `${big}a`)] }))
      after.set(id, golden({ scenario: id, checkpoints: [checkpoint('c', [], `${big}b`)] }))
    }
    const markdown = formatChangeMarkdown(diffGoldenSets('base', before, after), 20_000)
    expect(markdown.length).toBeLessThan(40_000)
    expect(markdown).toContain('_Details stop here')
    expect(markdown).toContain('- g199')
  })

  it('decodes a pooled file of any format version', () => {
    const recording: Recording = { scenario: 's', checkpoints: [checkpoint('one', [sent('a')])] }
    const interned = internRecording(recording)
    const file = {
      goldenFormatVersion: 5,
      baseline: 'x',
      operation: 'op',
      family: 'fam',
      namedDeltas: [],
      ...interned
    }
    expect(decodeGoldenFile(file, 'g').recording).toEqual(recording)
  })
})
