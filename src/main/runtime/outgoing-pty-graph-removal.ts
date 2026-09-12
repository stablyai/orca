import { bindOutgoingPtyGraph, type PtyGraph } from './orca-runtime-outgoing-pty-graph'

type MutablePtyGraph = {
  [Field in keyof PtyGraph]: PtyGraph[Field] extends ReadonlyMap<infer Key, infer Value>
    ? Map<Key, Value>
    : never
}

/** Caller holds durable cleanup intent and fresh authority; this removes no process or model. */
export function prepareOutgoingPtyGraphRemoval(
  ptyIds: readonly string[],
  read: () => MutablePtyGraph
) {
  const ids = new Set(ptyIds)
  const assertBefore = bindOutgoingPtyGraph([...ids], read)
  const graph = read()
  const leaves = [...graph.leaves].filter(([, leaf]) => leaf.ptyId && ids.has(leaf.ptyId))
  const handles = new Set(
    [...graph.handles]
      .filter(([, record]) => record.ptyId && ids.has(record.ptyId))
      .map(([handle]) => handle)
  )
  for (const id of ids) {
    const direct = graph.byPty.get(id)
    const incarnation = graph.byIncarnation.get(id)
    if (direct) {
      handles.add(direct)
    }
    if (incarnation) {
      handles.add(incarnation.handle)
    }
  }
  for (const [key] of leaves) {
    const handle = graph.byLeaf.get(key)
    if (handle) {
      handles.add(handle)
    }
  }
  const aliases = [...graph.byLeaf].filter(([, handle]) => handles.has(handle))
  let assertRemoved: (() => void) | undefined
  return {
    assertCurrent: () => (assertRemoved ?? assertBefore)(),
    remove(): Readonly<{ handles: readonly string[]; leafKeys: readonly string[] }> {
      if (assertRemoved) {
        assertRemoved()
        return { handles: [...handles], leafKeys: leaves.map(([key]) => key) }
      }
      assertBefore()
      const current = read()
      // No awaits or callbacks between cohort validation and the map deletions.
      for (const [key] of leaves) {
        current.leaves.delete(key)
      }
      for (const handle of handles) {
        current.handles.delete(handle)
      }
      for (const [key] of aliases) {
        current.byLeaf.delete(key)
      }
      for (const id of ids) {
        current.byPty.delete(id)
        current.byIncarnation.delete(id)
      }
      assertRemoved = bindOutgoingPtyGraph([...ids], read)
      return { handles: [...handles], leafKeys: leaves.map(([key]) => key) }
    }
  }
}
