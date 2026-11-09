import type { NativeChatSubagentState } from '../../../../shared/native-chat/native-chat-types'
import {
  MAX_SUBAGENT_FIELD_CHARS,
  canReplaceSubagentState
} from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'

const MAX_SETTLED_TURNS = 256
/** Evicted turn ordinals fall back to first-run attribution. */
const MAX_TURN_ORDINALS_PER_CHILD = 64

export type CodexChildExecution = {
  turnId: string
  state: NativeChatSubagentState
}

export type CodexExecutionChild = {
  agentThreadId: string
  observationOrder: number
  registered: boolean
  label: string | null
  /** Spawn announcements arrive on the parent's thread. */
  spawnerThreadId: string | null
  execution: CodexChildExecution | null
  turnOrdinals: Map<string, number>
  turnCount: number
}

/** Child turn events own execution; activity items only identify the child. */
export class CodexSubagentExecutions {
  private readonly children = new Map<string, CodexExecutionChild>()
  private readonly settledTurns = new Map<string, NativeChatSubagentState>()
  private readonly working = new Map<string, CodexExecutionChild>()
  private readonly workingOrder: CodexExecutionChild[] = []
  private readonly workingBySpawner = new Map<string, Set<CodexExecutionChild>>()
  private readonly changed = new Set<string>()

  register(
    agentThreadId: string,
    label: string | null,
    spawnerThreadId?: string
  ): CodexExecutionChild {
    const child = this.child(agentThreadId)
    const previousLabel = child.label
    // Keep the original spawner across duplicate announcement frames.
    child.spawnerThreadId ??= spawnerThreadId ?? null
    child.registered = true
    // Retain one overflow unit so the journal can append its per-row truncation marker.
    child.label ??=
      label
        ?.trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_SUBAGENT_FIELD_CHARS + 1) || null
    this.updateWorking(child)
    if (previousLabel !== child.label) {
      this.changed.add(agentThreadId)
    }
    return child
  }

  observeTurn(
    agentThreadId: string,
    turnId: string,
    state: NativeChatSubagentState
  ): { child: CodexExecutionChild; execution: CodexChildExecution } | null {
    const key = JSON.stringify([agentThreadId, turnId])
    const settled = this.settledTurns.get(key)
    if (state === 'working' && settled !== undefined) {
      return null
    }
    const child = this.child(agentThreadId)
    this.numberTurn(child, turnId)
    if (
      state === 'working' &&
      child.execution?.turnId === turnId &&
      child.execution.state !== 'working'
    ) {
      return null
    }
    // A known outcome latches; lost contact can still be replaced by a later verdict.
    const execution = {
      turnId,
      state: settled !== undefined && !canReplaceSubagentState(settled, state) ? settled : state
    }
    if (state !== 'working') {
      this.settledTurns.set(key, execution.state)
      while (this.settledTurns.size > MAX_SETTLED_TURNS) {
        const oldest = this.settledTurns.keys().next().value
        if (oldest === undefined) {
          break
        }
        this.settledTurns.delete(oldest)
      }
    }
    if (state === 'working' || !child.execution || child.execution.turnId === turnId) {
      child.execution = execution
      this.updateWorking(child)
    }
    return { child, execution }
  }

  /** Closing a working child without turn/completed leaves its outcome unknown. */
  closeThread(agentThreadId: string): void {
    const current = this.children.get(agentThreadId)?.execution
    if (current?.state === 'working') {
      this.observeTurn(agentThreadId, current.turnId, 'unverifiable')
    }
  }

  /** Retain labels for rows that outlive their child's turn. */
  label(agentThreadId: string): string | null {
    return this.children.get(agentThreadId)?.label ?? null
  }

  spawnerOf(agentThreadId: string): string | null {
    return this.children.get(agentThreadId)?.spawnerThreadId ?? null
  }

  /** One-based observed run number; null for unseen or evicted turns. */
  turnOrdinal(agentThreadId: string, turnId: string): number | null {
    return this.children.get(agentThreadId)?.turnOrdinals.get(turnId) ?? null
  }

  find(agentThreadId: string): Readonly<CodexExecutionChild> | undefined {
    return this.children.get(agentThreadId)
  }

  lineage(roots: ReadonlySet<string>, commandThreads: Iterable<string>): CodexExecutionChild[] {
    const selected = new Map<string, CodexExecutionChild>()
    const reachesRoot = new Map<string, boolean>()
    const candidates = new Set([...this.working.keys(), ...commandThreads])
    for (const threadId of candidates) {
      let id = threadId
      const path = new Set<string>()
      while (!roots.has(id) && !reachesRoot.has(id) && !path.has(id)) {
        path.add(id)
        const spawner = this.children.get(id)?.spawnerThreadId
        if (spawner === null || spawner === undefined) {
          break
        }
        id = spawner
      }
      const included = roots.has(id) || reachesRoot.get(id) === true
      for (const ancestor of path) {
        reachesRoot.set(ancestor, included)
      }
      if (included) {
        for (const ancestor of [...path, id]) {
          const child = this.children.get(ancestor)
          if (child) {
            selected.set(ancestor, child)
          }
        }
      }
    }
    const spawnedBy = new Map<string, CodexExecutionChild[]>()
    for (const child of [...selected.values()].sort(
      (a, b) => a.observationOrder - b.observationOrder
    )) {
      if (child.spawnerThreadId !== null) {
        const siblings = spawnedBy.get(child.spawnerThreadId) ?? []
        siblings.push(child)
        spawnedBy.set(child.spawnerThreadId, siblings)
      }
    }
    const lineage: CodexExecutionChild[] = []
    const seen = new Set<string>()
    for (const root of roots) {
      const pending = [root]
      for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        const child = selected.get(id)
        if (!child || seen.has(id)) {
          continue
        }
        seen.add(id)
        lineage.push(child)
        for (const spawned of spawnedBy.get(id) ?? []) {
          pending.push(spawned.agentThreadId)
        }
      }
    }
    return lineage
  }

  workingChildren(): CodexExecutionChild[] {
    return [...this.workingOrder]
  }

  workingSpawnedBy(threadId: string): CodexExecutionChild[] {
    return [...(this.workingBySpawner.get(threadId) ?? [])]
  }

  takeChangedThreads(): string[] {
    const threads = [...this.changed]
    this.changed.clear()
    return threads
  }

  clear(): void {
    this.children.clear()
    this.settledTurns.clear()
    this.working.clear()
    this.workingOrder.length = 0
    this.workingBySpawner.clear()
    this.changed.clear()
  }

  retentionSizes(): { children: number; settledTurns: number } {
    return { children: this.children.size, settledTurns: this.settledTurns.size }
  }

  private child(agentThreadId: string): CodexExecutionChild {
    const existing = this.children.get(agentThreadId)
    if (existing) {
      return existing
    }
    const child: CodexExecutionChild = {
      agentThreadId,
      observationOrder: this.children.size,
      registered: false,
      label: null,
      spawnerThreadId: null,
      execution: null,
      turnOrdinals: new Map(),
      turnCount: 0
    }
    this.children.set(agentThreadId, child)
    return child
  }

  private updateWorking(child: CodexExecutionChild): void {
    const working = child.registered && child.execution?.state === 'working'
    if (working !== this.working.has(child.agentThreadId)) {
      this.changed.add(child.agentThreadId)
      if (working) {
        this.working.set(child.agentThreadId, child)
        const next = this.workingOrder.findIndex(
          (other) => other.observationOrder > child.observationOrder
        )
        this.workingOrder.splice(next === -1 ? this.workingOrder.length : next, 0, child)
      } else {
        this.working.delete(child.agentThreadId)
        this.workingOrder.splice(this.workingOrder.indexOf(child), 1)
      }
    }
    const spawner = child.spawnerThreadId
    if (spawner !== null) {
      const children = this.workingBySpawner.get(spawner) ?? new Set<CodexExecutionChild>()
      if (working) {
        children.add(child)
        this.workingBySpawner.set(spawner, children)
      } else {
        children.delete(child)
        if (children.size === 0) {
          this.workingBySpawner.delete(spawner)
        }
      }
    }
  }

  private numberTurn(child: CodexExecutionChild, turnId: string): void {
    if (child.turnOrdinals.has(turnId)) {
      return
    }
    child.turnCount += 1
    child.turnOrdinals.set(turnId, child.turnCount)
    if (child.turnOrdinals.size > MAX_TURN_ORDINALS_PER_CHILD) {
      const oldest = child.turnOrdinals.keys().next().value
      if (oldest !== undefined) {
        child.turnOrdinals.delete(oldest)
      }
    }
  }
}

export function codexChildTurnState(status: unknown): NativeChatSubagentState {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'interrupted') {
    return 'stopped'
  }
  if (status === 'failed') {
    return 'failed'
  }
  return 'unverifiable'
}
