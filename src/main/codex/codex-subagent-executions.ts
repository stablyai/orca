import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  MAX_SUBAGENT_FIELD_CHARS,
  canReplaceSubagentState
} from '../../shared/native-chat/transcript/native-chat-subagent-summary'

const MAX_SETTLED_TURNS = 256
/** Evicted turn ordinals fall back to first-run attribution. */
const MAX_TURN_ORDINALS_PER_CHILD = 64

export type CodexChildExecution = {
  turnId: string
  state: NativeChatSubagentState
}

export type CodexExecutionChild = {
  agentThreadId: string
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

  register(
    agentThreadId: string,
    label: string | null,
    spawnerThreadId?: string
  ): CodexExecutionChild {
    const child = this.child(agentThreadId)
    // Keep the original spawner across duplicate announcement frames.
    child.spawnerThreadId ??= spawnerThreadId ?? null
    child.registered = true
    // Retain one overflow unit so the journal can append its per-row truncation marker.
    child.label ??=
      label
        ?.trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_SUBAGENT_FIELD_CHARS + 1) || null
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

  lineage(agentThreadId: string): CodexExecutionChild[] {
    const spawnedByThread = new Map<string, string[]>()
    for (const child of this.children.values()) {
      if (child.spawnerThreadId === null) {
        continue
      }
      const siblings = spawnedByThread.get(child.spawnerThreadId) ?? []
      siblings.push(child.agentThreadId)
      spawnedByThread.set(child.spawnerThreadId, siblings)
    }
    const lineage: CodexExecutionChild[] = []
    const seen = new Set<string>()
    const pending = [agentThreadId]
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const child = this.children.get(id)
      if (!child || seen.has(id)) {
        continue
      }
      seen.add(id)
      lineage.push(child)
      for (const spawned of spawnedByThread.get(id) ?? []) {
        pending.push(spawned)
      }
    }
    return lineage
  }

  workingChildren(): CodexExecutionChild[] {
    return [...this.children.values()].filter(
      (child) => child.registered && child.execution?.state === 'working'
    )
  }

  clear(): void {
    this.children.clear()
    this.settledTurns.clear()
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
