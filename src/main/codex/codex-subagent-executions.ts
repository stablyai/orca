import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'

const MAX_CHILDREN = 128
const MAX_SETTLED_TURNS = 256
/** Turn ordinals remembered per child; a row from an older run reads as its first. */
const MAX_TURN_ORDINALS_PER_CHILD = 64

export type CodexChildExecution = {
  turnId: string
  state: NativeChatSubagentState
}

export type CodexExecutionChild = {
  agentThreadId: string
  registered: boolean
  label: string | null
  parentTurnId: string | null
  /** The thread whose stream carried this child's `started` activity. Codex
   *  emits that item on the spawning agent's own session, so it names the parent. */
  spawnerThreadId: string | null
  execution: CodexChildExecution | null
  /** Which run each observed turn was, in the order the child's turns began. */
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
    parentTurnId: string | null | undefined,
    spawnerThreadId?: string
  ): CodexExecutionChild | undefined {
    const child = this.child(agentThreadId)
    if (!child) {
      return undefined
    }
    if (!child.registered || parentTurnId !== undefined) {
      child.parentTurnId = parentTurnId ?? null
    }
    // A child is spawned once; its announcement is delivered twice, never by another thread.
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
    if (!child) {
      return null
    }
    this.numberTurn(child, turnId)
    if (
      state === 'working' &&
      child.execution?.turnId === turnId &&
      child.execution.state !== 'working'
    ) {
      return null
    }
    const execution = { turnId, state: settled ?? state }
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

  /** A child turn that ended with no `turn/completed`. With no turn named, the one the child is
   *  running ended; a child running none has nothing to end. The first ending a turn gets stands. */
  endTurn(
    agentThreadId: string,
    turnId: string | null,
    state: Exclude<NativeChatSubagentState, 'working'>
  ): void {
    const current = this.children.get(agentThreadId)?.execution
    const ended = turnId ?? (current?.state === 'working' ? current.turnId : null)
    if (current && ended !== null) {
      this.observeTurn(agentThreadId, ended, state)
    }
  }

  /** Survives the child's turn, so a row outliving that turn can still name it. */
  label(agentThreadId: string): string | null {
    return this.children.get(agentThreadId)?.label ?? null
  }

  spawnerOf(agentThreadId: string): string | null {
    return this.children.get(agentThreadId)?.spawnerThreadId ?? null
  }

  /** Which run of the child a turn was: 1 for the turn it was spawned into, then
   *  one more per follow-up turn. Null when the turn was never observed. */
  turnOrdinal(agentThreadId: string, turnId: string): number | null {
    return this.children.get(agentThreadId)?.turnOrdinals.get(turnId) ?? null
  }

  /** The child as last observed, without creating one. */
  find(agentThreadId: string): Readonly<CodexExecutionChild> | undefined {
    return this.children.get(agentThreadId)
  }

  workingChildren(): CodexExecutionChild[] {
    return [...this.children.values()].filter(
      (child) => child.registered && child.execution?.state === 'working'
    )
  }

  settleSession(): void {
    for (const child of this.children.values()) {
      if (child.execution?.state === 'working') {
        child.execution = { ...child.execution, state: 'unverifiable' }
      }
    }
  }

  clear(): void {
    this.children.clear()
    this.settledTurns.clear()
  }

  /** Retention bounds are not observable through the child/turn API, so expose the two counts. */
  retentionSizes(): { children: number; settledTurns: number } {
    return { children: this.children.size, settledTurns: this.settledTurns.size }
  }

  private child(agentThreadId: string): CodexExecutionChild | undefined {
    const existing = this.children.get(agentThreadId)
    if (existing) {
      return existing
    }
    if (this.children.size >= MAX_CHILDREN) {
      const settled = [...this.children].find(([, child]) => child.execution?.state !== 'working')
      if (!settled) {
        return undefined
      }
      this.children.delete(settled[0])
    }
    const child: CodexExecutionChild = {
      agentThreadId,
      registered: false,
      label: null,
      parentTurnId: null,
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
