import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'

const MAX_CHILDREN = 128
const MAX_SETTLED_TURNS = 256

export type CodexChildExecution = {
  turnId: string
  state: NativeChatSubagentState
}

export type CodexExecutionChild = {
  agentThreadId: string
  registered: boolean
  label: string | null
  parentTurnId: string | null
  execution: CodexChildExecution | null
}

/** Child turn events own execution; activity items only identify the child. */
export class CodexSubagentExecutions {
  private readonly children = new Map<string, CodexExecutionChild>()
  private readonly settledTurns = new Map<string, NativeChatSubagentState>()

  register(
    agentThreadId: string,
    label: string | null,
    parentTurnId: string | null | undefined
  ): CodexExecutionChild | undefined {
    const child = this.child(agentThreadId)
    if (!child) {
      return undefined
    }
    if (!child.registered || parentTurnId !== undefined) {
      child.parentTurnId = parentTurnId ?? null
    }
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

  /** Survives the child's turn, so a row outliving that turn can still name it. */
  label(agentThreadId: string): string | null {
    return this.children.get(agentThreadId)?.label ?? null
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
      execution: null
    }
    this.children.set(agentThreadId, child)
    return child
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
