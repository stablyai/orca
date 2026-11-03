import type { DispatchContextRow } from './orchestration/types'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import {
  resolveWorkerLineageFacts,
  type WorkerLineageFacts
} from './orchestration/db/dispatch-context/worker-follow-up-plan'

type Facts = WorkerLineageFacts<DispatchContextRow, WorkerTerminalResourceRow>
type Lineage = ReturnType<
  typeof resolveWorkerLineageFacts<DispatchContextRow, WorkerTerminalResourceRow>
>
type Node = {
  row: DispatchContextRow | undefined
  resource: WorkerTerminalResourceRow | undefined
  followUp: DispatchContextRow | undefined
  edges: Set<string>
  shared?: boolean
  resolved?: { value: Lineage }
}

/** Direct facts belong to reachable Dispatches, never to every alias that traversed them. */
export class AgentSenderLineageGraph {
  private readonly nodes = new Map<string, Node>()
  private readonly reverse = new Map<string, Set<string>>()
  private visit: () => void = () => {}

  clear(): void {
    this.nodes.clear()
    this.reverse.clear()
  }

  invalidate(ids: Iterable<string>, visit: () => void): boolean {
    this.visit = visit
    const dirty = new Set(ids)
    const affected = new Set(dirty)
    const pending = [...dirty]
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      visit()
      for (const dependent of this.reverse.get(id) ?? []) {
        visit()
        if (!affected.has(dependent)) {
          affected.add(dependent)
          pending.push(dependent)
        }
      }
    }
    let changed = false
    // Collect the closure before removing any of its edges.
    for (const id of affected) {
      const node = this.nodes.get(id)
      if (node) {
        changed = true
        node.resolved = undefined
        node.shared = undefined
      }
    }
    for (const id of dirty) {
      this.remove(id)
    }
    return changed
  }

  retain(roots: Iterable<string>, facts: Facts, visit: () => void): void {
    this.visit = visit
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
        const resource = facts.ownedResource(id) ?? facts.formerResource(id)
        const followUp = facts.followUp(id)
        const edges = new Set(
          [row?.follow_up_of_dispatch_id, followUp?.id, resource?.owner_dispatch_id].filter(
            (key): key is string => !!key && key !== id
          )
        )
        node = { row, resource, followUp, edges }
        this.nodes.set(id, node)
        for (const key of edges) {
          this.reverse.set(key, (this.reverse.get(key) ?? new Set()).add(id))
        }
      }
      for (const key of node.edges) {
        visit()
        pending.push(key)
      }
    }
    for (const id of this.nodes.keys()) {
      if (!seen.has(id)) {
        this.remove(id)
      }
    }
  }

  row(id: string): DispatchContextRow | undefined {
    return this.nodes.get(id)?.row
  }

  resolve(id: string): Lineage {
    const node = this.nodes.get(id)
    if (!node) {
      return undefined
    }
    if (!node.resolved && node.shared === undefined) {
      this.shareChain(id)
    }
    if (!node.resolved) {
      // Cycles, transfers and non-reciprocal branches retain the addressed root's context.
      const read = (key: string) => {
        this.visit()
        return this.nodes.get(key)
      }
      node.resolved = {
        value: resolveWorkerLineageFacts(
          {
            dispatch: (key) => read(key)?.row,
            ownedResource: (key) => read(key)?.resource,
            formerResource: () => undefined,
            followUp: (key) => read(key)?.followUp
          },
          id
        )
      }
    }
    return node.resolved.value
  }

  keys(): Iterable<string> {
    return this.nodes.keys()
  }

  sizeForTest() {
    const edges = [...this.nodes.values()].reduce((sum, node) => sum + node.edges.size, 0)
    const reverseMemberships = [...this.reverse.values()].reduce((sum, ids) => sum + ids.size, 0)
    return { nodes: this.nodes.size, edges, reverseMemberships }
  }

  private shareChain(id: string): void {
    const component = new Set<string>()
    const pending = [id]
    let shareable = true
    let tail: Node | undefined
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      if (component.has(key)) {
        continue
      }
      component.add(key)
      this.visit()
      const node = this.nodes.get(key)
      if (!node) {
        continue
      }
      for (const next of [...node.edges, ...(this.reverse.get(key) ?? [])]) {
        this.visit()
        pending.push(next)
      }
      if (!node.row) {
        shareable = false
        continue
      }
      const parent = node.row.follow_up_of_dispatch_id
      const prior = parent ? this.nodes.get(parent)?.row : undefined
      shareable &&=
        (!prior || this.nodes.get(prior.id)?.followUp?.id === key) &&
        (!node.followUp || node.followUp.follow_up_of_dispatch_id === key)
      if (!node.followUp) {
        shareable &&= tail === undefined
        tail = node
      }
    }
    // Share only when forward traversal cannot return behind the resource it carries.
    const position = new Map<string, number>()
    let resource: WorkerTerminalResourceRow | undefined
    if (shareable && tail) {
      let current: Node | undefined = tail
      while (current?.row) {
        this.visit()
        if (position.has(current.row.id)) {
          shareable = false
          break
        }
        position.set(current.row.id, position.size)
        resource ??= current.resource
        const parent = current.row.follow_up_of_dispatch_id
        current = parent ? this.nodes.get(parent) : undefined
      }
      // Resource edges may join otherwise separate chains or cycles into this component.
      shareable &&= position.size === component.size
      for (const key of component) {
        const held = this.nodes.get(key)?.resource
        if (held && this.nodes.get(held.owner_dispatch_id)?.row) {
          const owner = position.get(held.owner_dispatch_id)
          const at = position.get(key)
          shareable &&= owner !== undefined && at !== undefined && owner <= at
        }
      }
    }
    const shared = tail?.row ? { value: { latest: tail.row, resource } } : undefined
    for (const key of component) {
      const node = this.nodes.get(key)
      if (node) {
        node.shared = shareable && !!tail
        if (node.shared) {
          node.resolved = node.row ? shared : { value: undefined }
        }
      }
    }
  }

  private remove(id: string): void {
    const node = this.nodes.get(id)
    this.nodes.delete(id)
    for (const key of node?.edges ?? []) {
      this.visit()
      const ids = this.reverse.get(key)
      ids?.delete(id)
      if (ids?.size === 0) {
        this.reverse.delete(key)
      }
    }
  }
}
