// Codex child threads and persistent commands, decoded into child-work evidence for the host's
// records.
//
// The background-task tracker already follows which child exists, which turn it runs and how that
// turn ended (the executions), and which persistent command started or exited (the command
// tracker). This module keeps what only the records read — the tool a child has open, what it said
// last, its usage, whether it waits on the user — and after each frame re-derives the whole
// observation of the child that frame was about. Edges are stamped with the host clock when
// drained, after the journal handled the frame, so the host never holds a record ahead of the
// frame's own rows. A parent turn ending is never evidence here: Codex children outlive the turn
// that spawned them, so only a child's own turn, or the session, ends it.

import type { AgentSessionBackgroundTask } from '../../shared/agent-session-wire'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../shared/agent-status-child-work-evidence'
import type { CodexBackgroundCommandChange } from './codex-background-command-tracker'
import type {
  CodexBackgroundTaskEvent,
  CodexBackgroundTaskFrame
} from './codex-background-task-frames'
import {
  codexChildMessageText,
  codexChildToolCall,
  codexChildTurnOutcome,
  codexCommandOutcome,
  codexToolCallEnded,
  type CodexChildToolCall
} from './codex-child-work-translation'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import { readRecord } from './codex-item-field-readers'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { codexThreadWaitsOnUser, readCodexTurnId } from './codex-structured-thread-facts'
import { CODEX_TOKEN_USAGE_METHOD, readCodexThreadTokenTotal } from './codex-subagent-activity'
import type { CodexExecutionChild, CodexSubagentExecutions } from './codex-subagent-executions'

/** The executions' own child bound. */
const MAX_CHILD_FACTS = 128
const MAX_OPEN_CALLS_PER_CHILD = 16
const CHILD_FRAME_METHODS: ReadonlySet<string> = new Set([
  'item/started',
  'item/completed',
  'thread/status/changed',
  CODEX_TOKEN_USAGE_METHOD
])

/** A tool call a child has started and not finished. `openedAt` is the host clock of the first
 *  drain that carried it, so a later edge keeps the time the call opened. */
type OpenCall = CodexChildToolCall & { turnId: string | null; openedAt?: number }

type ChildFacts = {
  openCalls: Map<string, OpenCall>
  lastMessage?: { turnId: string | null; text: string }
  totalTokens?: number
  waiting: boolean
  /** The last observation handed to the host, so an unchanged re-derivation sends nothing. */
  published?: string
}

export type CodexPendingChildWork = (observedAt: number) => AgentChildWorkEvidence

/** Evidence from a run only counts for that run: a fact recorded under another turn is stale. */
function ofTurn<T extends { turnId: string | null }>(fact: T | undefined, turnId: string) {
  return fact?.turnId === turnId ? fact : undefined
}

function commandLive(task: AgentSessionBackgroundTask, ownerId: string | null) {
  return (observedAt: number): AgentChildWorkEvidence => ({
    type: 'live',
    observedAt,
    child: {
      handle: { idKind: 'task_id', id: task.id },
      kind: 'command',
      residency: 'background',
      state: 'working',
      ...(task.description ? { description: task.description } : {}),
      ...(ownerId !== null ? { ownerId } : {}),
      stoppable: false
    }
  })
}

export class CodexChildWorkEvidence {
  private readonly facts = new Map<string, ChildFacts>()
  private pending: CodexPendingChildWork[] = []

  constructor(
    private readonly primaryThreadId: string,
    private readonly executions: CodexSubagentExecutions,
    private readonly liveCommands: (threadId: string) => readonly AgentSessionBackgroundTask[]
  ) {}

  /** After the tracker applied the frame: what it did to a persistent command, and to the child
   *  the frame is about. */
  observe(
    event: CodexBackgroundTaskEvent,
    frame: CodexBackgroundTaskFrame | null,
    command: CodexBackgroundCommandChange | null
  ): void {
    if (command?.type === 'started') {
      this.pending.push(commandLive(command.task, this.commandOwner(command.threadId)))
    } else if (command?.type === 'ended') {
      const outcome = codexCommandOutcome(command.item)
      this.pending.push((observedAt) => ({
        type: 'ended',
        observedAt,
        handle: { idKind: 'task_id', id: command.taskId },
        outcome
      }))
    }
    const threadId = this.childThread(event, frame)
    if (threadId === null) {
      return
    }
    const facts = this.factsFor(threadId)
    if (facts && event.threadId === threadId) {
      this.record(facts, event)
    }
    this.queueChild(threadId)
  }

  /** The provider session is gone, and every child with it. */
  clear(): void {
    this.facts.clear()
    this.pending.push((observedAt) => ({ type: 'session-ended', observedAt }))
  }

  drain(observedAt: number): AgentChildWorkEvidence[] {
    const pending = this.pending
    this.pending = []
    return pending.map((edge) => edge(observedAt))
  }

  private childThread(
    event: CodexBackgroundTaskEvent,
    frame: CodexBackgroundTaskFrame | null
  ): string | null {
    const threadId =
      frame?.kind === 'subagent'
        ? frame.agentThreadId
        : frame || CHILD_FRAME_METHODS.has(event.method)
          ? event.threadId
          : null
    return threadId === this.primaryThreadId ? null : threadId
  }

  /** A command belongs to the child thread that launched it; the session's own agent is no owner. */
  private commandOwner(threadId: string): string | null {
    return threadId === this.primaryThreadId ? null : threadId
  }

  private record(facts: ChildFacts, event: CodexBackgroundTaskEvent): void {
    if (event.method === CODEX_TOKEN_USAGE_METHOD) {
      facts.totalTokens = readCodexThreadTokenTotal(event.params)?.totalTokens ?? facts.totalTokens
      return
    }
    if (event.method === 'thread/status/changed') {
      facts.waiting = codexThreadWaitsOnUser(event.params)
      return
    }
    const item = readCodexThreadItem(readRecord(event.params).item)
    if (!item || codexCommandOutlivesTurn(item)) {
      return
    }
    // A frame that names no turn belongs to the one the child is running.
    const turnId =
      readCodexTurnId(event.params) ??
      this.executions.find(event.threadId)?.execution?.turnId ??
      null
    const text = event.method === 'item/completed' ? codexChildMessageText(item) : undefined
    if (text) {
      facts.lastMessage = { turnId, text }
    }
    // An end closes the call by id alone: its closing frame need not restate what it ran.
    if (codexToolCallEnded(event.method, item)) {
      facts.openCalls.delete(item.id)
      return
    }
    const call = codexChildToolCall(item)
    if (call && !facts.openCalls.has(item.id)) {
      facts.openCalls.set(item.id, { ...call, turnId })
      for (const stale of [...facts.openCalls.keys()].slice(0, -MAX_OPEN_CALLS_PER_CHILD)) {
        facts.openCalls.delete(stale)
      }
    }
  }

  /** Re-derive the child's observation and hand it on when it changed. A child the provider has
   *  not announced, or that never ran a turn, is no record. */
  private queueChild(threadId: string): void {
    const child = this.executions.find(threadId)
    const facts = this.facts.get(threadId)
    if (!child?.registered || !child.execution || !facts) {
      return
    }
    const { turnId, state } = child.execution
    if (state !== 'working') {
      // The turn is over, and so is every call it had open.
      facts.openCalls.clear()
      facts.waiting = false
      const lastMessage = ofTurn(facts.lastMessage, turnId)?.text
      const { totalTokens } = facts
      const outcome = codexChildTurnOutcome(state)
      this.publish(facts, JSON.stringify(['ended', turnId, state]), (observedAt) => ({
        type: 'ended',
        observedAt,
        handle: { idKind: 'thread_id', id: threadId, runId: turnId },
        outcome,
        ...(lastMessage ? { lastMessage } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {})
      }))
      return
    }
    for (const [itemId, call] of facts.openCalls) {
      if (!ofTurn(call, turnId)) {
        facts.openCalls.delete(itemId)
      }
    }
    const observation = this.liveAgent(threadId, child, facts, turnId)
    const openCall = [...facts.openCalls].at(-1)
    const announced = facts.published !== undefined
    this.publish(facts, JSON.stringify(['live', observation, openCall?.[0]]), (observedAt) => {
      if (!openCall) {
        return { type: 'live', observedAt, child: { ...observation, operation: null } }
      }
      const [, call] = openCall
      call.openedAt ??= observedAt
      const operation = {
        toolName: call.toolName,
        ...(call.input ? { input: call.input } : {}),
        basis: 'open' as const,
        observedAt: call.openedAt
      }
      return { type: 'live', observedAt, child: { ...observation, operation } }
    })
    if (!announced) {
      this.requeueOwnedBy(threadId)
    }
  }

  private liveAgent(
    threadId: string,
    child: Readonly<CodexExecutionChild>,
    facts: ChildFacts,
    turnId: string
  ): AgentChildWorkLiveObservation {
    const lastMessage = ofTurn(facts.lastMessage, turnId)?.text
    const spawner = child.spawnerThreadId
    return {
      handle: { idKind: 'thread_id', id: threadId, runId: turnId },
      kind: 'agent',
      // A spawned child may outlive the turn that spawned it.
      residency: 'background',
      state: facts.waiting ? 'waiting' : 'working',
      // The agent path's last segment is the child's only label; today's row shows it there.
      ...(child.label ? { description: child.label } : {}),
      ...(facts.totalTokens !== undefined ? { totalTokens: facts.totalTokens } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...(spawner && spawner !== this.primaryThreadId ? { ownerId: spawner } : {}),
      stoppable: false
    }
  }

  private publish(facts: ChildFacts, fingerprint: string, edge: CodexPendingChildWork): void {
    if (facts.published !== fingerprint) {
      facts.published = fingerprint
      this.pending.push(edge)
    }
  }

  /** Work a child launched before the host held its record was admitted with no owner; now that
   *  the owner is recorded, say again whose it is. */
  private requeueOwnedBy(threadId: string): void {
    for (const task of this.liveCommands(threadId)) {
      this.pending.push(commandLive(task, threadId))
    }
    for (const spawned of this.executions.workingChildren()) {
      const facts = this.facts.get(spawned.agentThreadId)
      if (spawned.spawnerThreadId === threadId && facts?.published !== undefined) {
        facts.published = undefined
        this.queueChild(spawned.agentThreadId)
      }
    }
  }

  private factsFor(threadId: string): ChildFacts | undefined {
    const existing = this.facts.get(threadId)
    if (existing) {
      return existing
    }
    if (this.facts.size >= MAX_CHILD_FACTS) {
      const idle = [...this.facts.keys()].find(
        (id) => this.executions.find(id)?.execution?.state !== 'working'
      )
      if (idle === undefined) {
        return undefined
      }
      this.facts.delete(idle)
    }
    const facts: ChildFacts = { openCalls: new Map(), waiting: false }
    this.facts.set(threadId, facts)
    return facts
  }
}
