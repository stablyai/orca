import type { RuntimeLeafRecord } from '../../../terminal/records/runtime-terminal-state-records'

type LeafIndex = Map<string, { key: string; leaf: RuntimeLeafRecord }>

/** Graph leaves by stable leaf id, built once per graph map and dropped with it: a graph replacement
 *  swaps the map, and a removal only deletes from it, so a cached hit still in the map is current. */
export class LeafIdIndex {
  private readonly byGraph = new WeakMap<ReadonlyMap<string, RuntimeLeafRecord>, LeafIndex>()

  find(
    leaves: ReadonlyMap<string, RuntimeLeafRecord>,
    leafId: string
  ): RuntimeLeafRecord | undefined {
    let index = this.byGraph.get(leaves)
    if (!index) {
      index = new Map()
      for (const [key, leaf] of leaves) {
        if (!index.has(leaf.leafId)) {
          index.set(leaf.leafId, { key, leaf })
        }
      }
      this.byGraph.set(leaves, index)
    }
    const hit = index.get(leafId)
    return hit && leaves.get(hit.key) === hit.leaf ? hit.leaf : undefined
  }
}
