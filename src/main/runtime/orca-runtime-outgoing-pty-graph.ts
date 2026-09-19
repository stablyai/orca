type PtyGraphRecord = { ptyId?: string | null }
export type PtyGraph = {
  leaves: ReadonlyMap<string, PtyGraphRecord>
  handles: ReadonlyMap<string, PtyGraphRecord>
  byLeaf: ReadonlyMap<string, string>
  byPty: ReadonlyMap<string, string>
  byIncarnation: ReadonlyMap<string, { handle: string }>
}
const identityFields = new Set([
  'ptyId',
  'worktreeId',
  'tabId',
  'leafId',
  'ptyGeneration',
  'runtimeId',
  'rendererGraphEpoch',
  'incarnationId',
  'handle',
  'leafKey'
])

/** Binds client graph identity without turning handle retirement into a process exit. */
export function bindOutgoingPtyGraph(ptyIds: readonly string[], read: () => PtyGraph) {
  const ids = new Set(ptyIds)
  const capture = () => {
    const graph = read()
    const entries = new Map<string, { reference: unknown; signature: string }>()
    const handles = new Set<string>()
    const leaves = new Set<string>()
    const assertHandleOwner = (handle: string, ptyId: string) => {
      const owner = graph.handles.get(handle)?.ptyId
      if (owner && owner !== ptyId) {
        throw new Error('orcad_outgoing_source_graph_alias_conflict')
      }
    }
    const add = (kind: string, key: string, value: object | string) => {
      entries.set(JSON.stringify([kind, key]), {
        reference: value,
        signature: JSON.stringify(
          typeof value === 'string'
            ? value
            : Object.entries(value)
                .filter(([field]) => identityFields.has(field))
                .sort(([a], [b]) => a.localeCompare(b))
        )
      })
    }
    for (const [key, leaf] of graph.leaves) {
      if (leaf.ptyId && ids.has(leaf.ptyId)) {
        leaves.add(key)
        add('leaf', key, leaf)
      }
    }
    for (const [key, handle] of graph.handles) {
      if (handle.ptyId && ids.has(handle.ptyId)) {
        handles.add(key)
        add('handle', key, handle)
      }
    }
    for (const id of ids) {
      const direct = graph.byPty.get(id)
      const incarnation = graph.byIncarnation.get(id)
      if (direct) {
        assertHandleOwner(direct, id)
        handles.add(direct)
        add('direct', id, direct)
      }
      if (incarnation) {
        assertHandleOwner(incarnation.handle, id)
        handles.add(incarnation.handle)
        add('incarnation', id, incarnation)
      }
    }
    for (const [key, handle] of graph.byLeaf) {
      if (leaves.has(key)) {
        handles.add(handle)
      }
    }
    for (const [key, handle] of graph.byLeaf) {
      if (handles.has(handle)) {
        const owner = graph.leaves.get(key)?.ptyId
        if (owner && !ids.has(owner)) {
          throw new Error('orcad_outgoing_source_graph_alias_conflict')
        }
        if (owner) {
          assertHandleOwner(handle, owner)
        }
        add('alias', key, handle)
      }
    }
    for (const [id, handle] of graph.byPty) {
      if (!ids.has(id) && handles.has(handle)) {
        throw new Error('orcad_outgoing_source_graph_alias_conflict')
      }
    }
    for (const [id, incarnation] of graph.byIncarnation) {
      if (!ids.has(id) && handles.has(incarnation.handle)) {
        throw new Error('orcad_outgoing_source_graph_alias_conflict')
      }
    }
    return entries
  }
  const before = capture()
  return () => {
    const after = capture()
    const changes = new Set<string>()
    const recordFields = new Set<string>()
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const kind = JSON.parse(key)[0] as string
      const original = before.get(key)
      const current = after.get(key)
      if (!original || !current) {
        changes.add(`${kind}:${original ? 'removed' : 'added'}`)
        continue
      }
      if (current.reference !== original.reference) {
        changes.add(`${kind}:reference`)
        if (
          typeof original.reference === 'object' &&
          original.reference &&
          typeof current.reference === 'object' &&
          current.reference
        ) {
          const left = original.reference as Record<string, unknown>
          const right = current.reference as Record<string, unknown>
          for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
            if (
              Object.hasOwn(left, field) !== Object.hasOwn(right, field) ||
              !Object.is(left[field], right[field])
            ) {
              recordFields.add(`${kind}.${field}`)
            }
          }
        }
      }
      if (current.signature !== original.signature) {
        changes.add(`${kind}:identity`)
      }
    }
    if (changes.size) {
      // Keep runtime identities and terminal content out of diagnostic evidence.
      throw new Error('orcad_outgoing_source_graph_changed', {
        cause: { changes: [...changes].sort(), recordFields: [...recordFields].sort() }
      })
    }
  }
}
