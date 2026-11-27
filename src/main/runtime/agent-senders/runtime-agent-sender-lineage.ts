import type { DispatchContextRow } from '../orchestration/db/orchestration-records'
import type { WorkerTerminalResourceRow } from '../orchestration/terminal-authority/release/worker-terminal-ownership'

export type AgentSenderLineageFacts = {
  dispatch: (id: string) => DispatchContextRow | undefined
  ownedResource: (id: string) => WorkerTerminalResourceRow | undefined
}

type Node = {
  row: DispatchContextRow | undefined
  resource: WorkerTerminalResourceRow | undefined
  parent: string | null
}

/** Direct facts belong to Dispatches in the candidate/parent closure, never forward or owner hops. */
export class AgentSenderLineageGraph {
  private readonly nodes = new Map<string, Node>()

  clear(): void {
    this.nodes.clear()
  }

  invalidate(ids: Iterable<string>, visit: () => void): boolean {
    let changed = false
    for (const id of new Set(ids)) {
      visit()
      if (this.nodes.delete(id)) {
        changed = true
      }
    }
    return changed
  }

  retain(roots: Iterable<string>, facts: AgentSenderLineageFacts, visit: () => void): void {
    const seen = new Set<string>()
    const pending = [...roots]
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id)) {
        continue
      }
      seen.add(id)
      visit()
      let node = this.nodes.get(id)
      if (!node) {
        const row = facts.dispatch(id)
        const resource = row ? facts.ownedResource(id) : undefined
        const parent =
          row?.follow_up_of_dispatch_id && row.follow_up_of_dispatch_id !== id
            ? row.follow_up_of_dispatch_id
            : null
        node = { row, resource, parent }
        this.nodes.set(id, node)
      }
      if (node.parent) {
        visit()
        pending.push(node.parent)
      }
    }
    for (const id of this.nodes.keys()) {
      if (!seen.has(id)) {
        visit()
        this.nodes.delete(id)
      }
    }
  }

  row(id: string): DispatchContextRow | undefined {
    return this.nodes.get(id)?.row
  }

  resource(id: string): WorkerTerminalResourceRow | undefined {
    return this.nodes.get(id)?.resource
  }

  keys(): Iterable<string> {
    return this.nodes.keys()
  }

  sizeForTest() {
    let edges = 0
    for (const node of this.nodes.values()) {
      if (node.parent) {
        edges++
      }
    }
    return { nodes: this.nodes.size, edges, reverseMemberships: 0 }
  }
}
