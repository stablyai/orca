import { expect, it } from 'vitest'
import { prepareOutgoingPtyGraphRemoval } from './outgoing-pty-graph-removal'

function fixture() {
  const graph = {
    leaves: new Map([
      ['source-pane', { ptyId: 'source', ptyGeneration: 1 }],
      ['other-pane', { ptyId: 'other', ptyGeneration: 1 }]
    ]),
    handles: new Map([
      ['term-source', { ptyId: 'source' }],
      ['term-other', { ptyId: 'other' }]
    ]),
    byLeaf: new Map([
      ['source-pane', 'term-source'],
      ['orphan-source-alias', 'term-source'],
      ['other-pane', 'term-other']
    ]),
    byPty: new Map([
      ['source', 'term-source'],
      ['other', 'term-other']
    ]),
    byIncarnation: new Map([
      ['source', { handle: 'term-source' }],
      ['other', { handle: 'term-other' }]
    ])
  }
  return { graph, prepare: () => prepareOutgoingPtyGraphRemoval(['source'], () => graph) }
}

it('removes only exact source graph entries and returns handles for separate waiter retirement', () => {
  const { graph, prepare } = fixture()
  const other = graph.leaves.get('other-pane')
  const remove = prepare().remove
  const result = remove()
  expect(result).toEqual({ handles: ['term-source'], leafKeys: ['source-pane'] })
  expect([...graph.leaves.keys()]).toEqual(['other-pane'])
  expect(graph.leaves.get('other-pane')).toBe(other)
  expect([...graph.handles.keys()]).toEqual(['term-other'])
  expect([...graph.byLeaf]).toEqual([['other-pane', 'term-other']])
  expect([...graph.byPty]).toEqual([['other', 'term-other']])
  expect([...graph.byIncarnation.keys()]).toEqual(['other'])
  expect(remove()).toEqual(result)
})

it.each(['replace', 'generation', 'alias'] as const)(
  'refuses %s drift before any deletion',
  (drift) => {
    const { graph, prepare } = fixture()
    const remove = prepare().remove
    if (drift === 'replace') {
      graph.leaves.set('source-pane', { ptyId: 'source', ptyGeneration: 1 })
    }
    if (drift === 'generation') {
      graph.leaves.get('source-pane')!.ptyGeneration++
    }
    if (drift === 'alias') {
      graph.byLeaf.set('new-alias', 'term-source')
    }
    const before = structuredClone(graph)
    expect(remove).toThrow('graph_changed')
    expect(graph).toEqual(before)
  }
)

it('does not delete resurrected source state on a repeated call', () => {
  const { graph, prepare } = fixture()
  const remove = prepare().remove
  remove()
  const replacement = { ptyId: 'source', ptyGeneration: 2 }
  graph.leaves.set('source-pane', replacement)
  expect(remove).toThrow('graph_changed')
  expect(graph.leaves.get('source-pane')).toBe(replacement)
})

it('refuses cross-PTY aliases before preparing removal', () => {
  const { graph, prepare } = fixture()
  graph.byLeaf.set('other-pane', 'term-source')
  const before = structuredClone(graph)
  expect(prepare).toThrow('graph_alias_conflict')
  expect(graph).toEqual(before)
})

it('removes a source leaf alias even when its handle record is missing', () => {
  const { graph, prepare } = fixture()
  graph.handles.delete('term-source')
  graph.byPty.delete('source')
  graph.byIncarnation.delete('source')
  expect(prepare().remove().handles).toEqual(['term-source'])
  expect([...graph.byLeaf]).toEqual([['other-pane', 'term-other']])
})

it('validates the entire cohort before removing its first entry', () => {
  const { graph } = fixture()
  const remove = prepareOutgoingPtyGraphRemoval(['source', 'other'], () => graph).remove
  graph.leaves.get('other-pane')!.ptyGeneration++
  const changed = structuredClone(graph)
  expect(remove).toThrow('graph_changed')
  expect(graph).toEqual(changed)
  graph.leaves.get('other-pane')!.ptyGeneration--
  expect(remove().handles).toEqual(['term-source', 'term-other'])
  for (const map of Object.values(graph)) {
    expect(map.size).toBe(0)
  }
})
