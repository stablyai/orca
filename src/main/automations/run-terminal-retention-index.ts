import type { AutomationRun } from '../../shared/automations-types'
import { compareAutomationRunsNewestFirst } from '../../shared/automation-run-cursor'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import type { AutomationRunMutation } from '../persistence/scheduling-automations/automation-run-operations'

export function compareRetainedRuns(a: AutomationRun, b: AutomationRun): number {
  return automationRunRecency(b) - automationRunRecency(a) || compareAutomationRunsNewestFirst(a, b)
}
export function resourceKey(run: AutomationRun): string {
  return JSON.stringify([run.automationId, run.workspaceId, run.terminalPaneKey, run.terminalPtyId])
}

/** One sweep's derivation; heap entries are bounded by source rows plus certified mutations. */
export class RunTerminalRetentionIndex {
  readonly byId = new Map<string, AutomationRun>()
  readonly byAutomation = new Map<string, Set<string>>()
  private readonly byResource = new Map<string, Set<string>>()
  private readonly byPane = new Map<string, AutomationRun[]>()
  private readonly creators = new Map<string, string>()

  constructor(runs: readonly AutomationRun[]) {
    for (const run of runs) {
      this.add(run)
    }
  }

  apply({ previous, updated }: AutomationRunMutation): void {
    this.byId.delete(previous.id)
    this.removeMember(this.byAutomation, previous.automationId, previous.id)
    this.removeMember(this.byResource, resourceKey(previous), previous.id)
    this.add(updated)
  }

  private removeMember(groups: Map<string, Set<string>>, key: string, id: string): void {
    const group = groups.get(key)
    group?.delete(id)
    if (group?.size === 0) {
      groups.delete(key)
      if (groups === this.byResource) {
        this.creators.delete(key)
      }
    }
  }

  private add(run: AutomationRun): void {
    this.byId.set(run.id, run)
    for (const [groups, key] of [
      [this.byAutomation, run.automationId],
      [this.byResource, resourceKey(run)]
    ] as const) {
      let group = groups.get(key)
      if (!group) {
        group = new Set()
        groups.set(key, group)
      }
      group.add(run.id)
    }
    if (!run.terminalPaneKey) {
      return
    }
    const heap = this.byPane.get(run.terminalPaneKey) ?? []
    this.byPane.set(run.terminalPaneKey, heap)
    let index = heap.length
    heap.push(run)
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (compareRetainedRuns(heap[parent], run) <= 0) {
        break
      }
      heap[index] = heap[parent]
      index = parent
    }
    heap[index] = run
  }

  latest(pane: string): AutomationRun | undefined {
    const heap = this.byPane.get(pane)
    while (heap?.length) {
      const first = heap[0]
      if (this.byId.get(first.id) === first) {
        return first
      }
      const last = heap.pop()!
      if (heap.length === 0) {
        break
      }
      let index = 0
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1
        if (child + 1 < heap.length && compareRetainedRuns(heap[child + 1], heap[child]) < 0) {
          child += 1
        }
        if (compareRetainedRuns(last, heap[child]) <= 0) {
          break
        }
        heap[index] = heap[child]
        index = child
      }
      heap[index] = last
    }
    return undefined
  }

  *ancestors(run: AutomationRun): Iterable<AutomationRun> {
    const key = resourceKey(run)
    const group = this.byResource.get(key)
    const hint = this.creators.get(key)
    if (hint && group?.has(hint)) {
      yield this.byId.get(hint)!
    }
    for (const id of group ?? []) {
      if (id !== hint) {
        yield this.byId.get(id)!
      }
    }
  }

  creator(run: AutomationRun, id: string): void {
    this.creators.set(resourceKey(run), id)
  }
}
