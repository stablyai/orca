import type { RuntimeLeafRecord } from '../../../terminal/records/runtime-terminal-state-records'

/** Graph leaves by stable leaf id, built once per graph map: a graph replacement swaps the map,
 *  and a removal only deletes from it, so a cached hit still in the map is current. */
export class LeafIdIndex {
  private source: ReadonlyMap<string, RuntimeLeafRecord> | null = null
  private readonly byLeafId = new Map<string, { key: string; leaf: RuntimeLeafRecord }>()

  find(
    leaves: ReadonlyMap<string, RuntimeLeafRecord>,
    leafId: string
  ): RuntimeLeafRecord | undefined {
    if (leaves !== this.source) {
      this.source = leaves
      this.byLeafId.clear()
      for (const [key, leaf] of leaves) {
        if (!this.byLeafId.has(leaf.leafId)) {
          this.byLeafId.set(leaf.leafId, { key, leaf })
        }
      }
    }
    const hit = this.byLeafId.get(leafId)
    return hit && leaves.get(hit.key) === hit.leaf ? hit.leaf : undefined
  }
}
