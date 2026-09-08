import { describe, expect, it } from 'vitest'
import { proveClaudeTranscriptBranchFromJsonl } from './claude-transcript-branch-proof'

const row = (uuid: string, parentUuid: string | null, extra = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: 'provider', uuid, parentUuid, ...extra })
const marker = (leafUuid: string) =>
  JSON.stringify({ type: 'last-prompt', sessionId: 'provider', leafUuid })
const graph = [row('root', null), row('kept', 'root'), row('old', 'kept')]
const prove = (rows: string[], leaf: string, intentionalRewindUuid?: string) =>
  proveClaudeTranscriptBranchFromJsonl({
    contents: `${[...rows, marker(leaf)].join('\n')}\n`,
    providerSessionId: 'provider',
    previousLeafUuid: 'old',
    intentionalRewindUuid
  })

describe('explicit Claude rewind ancestry', () => {
  it('admits only the exact requested main-chain ancestor', () => {
    expect(prove(graph, 'kept', 'kept')).toEqual({
      leafUuid: 'kept',
      relation: 'intentional-rewind'
    })
    expect(() => prove(graph, 'kept')).toThrow('sibling')
    expect(() => prove(graph, 'kept', 'root')).toThrow('target')
    expect(() => prove(graph, 'old', 'old')).toThrow('not an ancestor')
  })
  it('keeps sibling and sidechain rejection even with explicit intent', () => {
    expect(() => prove([...graph, row('sibling', 'root')], 'sibling', 'sibling')).toThrow(
      'not an ancestor'
    )
    expect(() =>
      prove(
        [row('root', null), row('kept', 'root', { isSidechain: true }), row('old', 'kept')],
        'kept',
        'kept'
      )
    ).toThrow()
  })
  it('refuses missing, reordered, or cyclic ancestry', () => {
    expect(() => prove(graph.slice(1), 'kept', 'kept')).toThrow('missing ancestor')
    expect(() => prove([graph[1]!, graph[0]!, graph[2]!], 'kept', 'kept')).toThrow(
      'parent row follows'
    )
    expect(() => prove([row('root', 'old'), ...graph.slice(1)], 'kept', 'kept')).toThrow('cycle')
  })
})
