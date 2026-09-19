import { expect, it } from 'vitest'
import { bindOutgoingPtyGraph } from './orca-runtime-outgoing-pty-graph'

function fixture() {
  const leaf = {
    ptyId: 'source',
    tabId: 'tab',
    leafId: 'leaf',
    worktreeId: 'folder:one',
    ptyGeneration: 1,
    title: 'first'
  }
  const handle = { ...leaf, handle: 'term-source', runtimeId: 'runtime', rendererGraphEpoch: 1 }
  const graph = {
    leaves: new Map([['pane', leaf]]),
    handles: new Map([['term-source', handle]]),
    byLeaf: new Map([['pane', 'term-source']]),
    byPty: new Map([['source', 'term-source']]),
    byIncarnation: new Map([
      ['source', { handle: 'term-source', incarnationId: 'incarnation', leafKey: 'pane' }]
    ])
  }
  return { graph, leaf, handle, assertCurrent: bindOutgoingPtyGraph(['source'], () => graph) }
}

it.each(['leaf', 'handle', 'direct', 'incarnation', 'alias'] as const)(
  'rejects replaced %s identity',
  (kind) => {
    const f = fixture()
    if (kind === 'leaf') {
      f.graph.leaves.set('pane', { ...f.leaf })
    } else if (kind === 'handle') {
      f.graph.handles.set('term-source', { ...f.handle })
    } else if (kind === 'direct') {
      f.graph.byPty.set('source', 'replacement')
    } else if (kind === 'incarnation') {
      f.graph.byIncarnation.set('source', { ...f.graph.byIncarnation.get('source')! })
    } else {
      f.graph.byLeaf.set('pane', 'replacement')
    }
    expect(f.assertCurrent).toThrow('graph_changed')
  }
)

it.each(['ptyGeneration', 'rendererGraphEpoch'] as const)(
  'rejects in-place %s changes',
  (field) => {
    const f = fixture()
    f.handle[field]++
    expect(f.assertCurrent).toThrow('graph_changed')
  }
)

it('rejects new source aliases, removed leaves and unknown newly registered source panes', () => {
  const f = fixture()
  f.graph.byLeaf.set('new-pane', 'term-source')
  expect(f.assertCurrent).toThrow('graph_changed')
  f.graph.byLeaf.delete('new-pane')
  f.graph.leaves.delete('pane')
  expect(f.assertCurrent).toThrow('graph_changed')
  const empty = new Map<string, { ptyId: string }>()
  const check = bindOutgoingPtyGraph(['source'], () => ({ ...f.graph, leaves: empty }))
  empty.set('late-pane', { ptyId: 'source' })
  expect(check).toThrow('graph_changed')
})

it('ignores presentation changes and other hosts without mutating any graph entry', () => {
  const f = fixture()
  f.leaf.title = 'new title'
  f.graph.leaves.set('other', { ...f.leaf, ptyId: 'other-host' })
  f.graph.handles.set('other-handle', { ...f.handle, ptyId: 'other-host' })
  f.graph.byLeaf.set('other', 'other-handle')
  f.graph.byPty.set('other-host', 'other-handle')
  f.assertCurrent()
  expect(f.graph.leaves.get('pane')).toBe(f.leaf)
  expect(f.graph.handles.get('term-source')).toBe(f.handle)
})

it('reports changed graph categories without exposing pane identities or values', () => {
  const f = fixture()
  f.graph.leaves.delete('pane')
  f.graph.handles.set('term-source', { ...f.handle })
  try {
    f.assertCurrent()
    throw new Error('expected graph refusal')
  } catch (error) {
    expect(error).toMatchObject({
      message: 'orcad_outgoing_source_graph_changed',
      cause: { changes: ['handle:reference', 'leaf:removed'] }
    })
  }
})

it.each([
  'direct-owner',
  'incarnation-owner',
  'leaf-owner',
  'foreign-direct',
  'foreign-incarnation',
  'foreign-leaf'
] as const)('refuses cross-PTY alias ownership at initial bind and revalidation (%s)', (kind) => {
  const f = fixture()
  f.graph.handles.set('foreign-handle', { ...f.handle, ptyId: 'foreign' })
  if (kind === 'direct-owner') {
    f.graph.byPty.set('source', 'foreign-handle')
  } else if (kind === 'incarnation-owner') {
    f.graph.byIncarnation.get('source')!.handle = 'foreign-handle'
  } else if (kind === 'leaf-owner') {
    f.graph.byLeaf.set('pane', 'foreign-handle')
  } else if (kind === 'foreign-direct') {
    f.graph.byPty.set('foreign', 'term-source')
  } else if (kind === 'foreign-incarnation') {
    f.graph.byIncarnation.set('foreign', {
      handle: 'term-source',
      incarnationId: 'foreign',
      leafKey: 'foreign'
    })
  } else {
    f.graph.leaves.set('foreign', { ...f.leaf, ptyId: 'foreign' })
    f.graph.byLeaf.set('foreign', 'term-source')
  }
  expect(f.assertCurrent).toThrow('alias_conflict')
  expect(() => bindOutgoingPtyGraph(['source'], () => f.graph)).toThrow('alias_conflict')
  expect(f.graph.handles.get('foreign-handle')?.ptyId).toBe('foreign')
})

it('detects foreign aliases preceding a source leaf alias with no handle record', () => {
  const f = fixture()
  f.graph.leaves.set('foreign', { ...f.leaf, ptyId: 'foreign' })
  f.graph.byLeaf = new Map([
    ['foreign', 'unrecorded'],
    ['pane', 'unrecorded']
  ])
  expect(() => bindOutgoingPtyGraph(['source'], () => f.graph)).toThrow('alias_conflict')
})
