import { traexChildAnnouncements } from './traex-child-announcements'
export { traexChildAnnouncements } from './traex-child-announcements'
import {
  traexChildAgentEvidence,
  traexChildCommandEvidence,
  type TraexChildAgent,
  type TraexChildCommand
} from './traex-child-work-evidence'
export type { TraexChildAgent, TraexChildCommand } from './traex-child-work-evidence'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { boundSubagentLabel } from '../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'
import {
  traexContentText,
  traexItemSchema,
  traexRecord,
  traexText,
  type TraexItem
} from './traex-protocol'

export function isTraexTerminalActivity(value: unknown): boolean {
  return [
    'commandExecution',
    'mcpToolCall',
    'dynamicToolCall',
    'terminalInteraction',
    'taskNotification'
  ].includes(traexText(traexRecord(value).type) ?? '')
}

export class TraexChildWork {
  readonly agents = new Map<string, TraexChildAgent>()
  readonly commands = new Map<string, TraexChildCommand>()
  terminalSupport: 'supported' | 'unsupported' | 'unknown' = 'unknown'
  private readonly pending: AgentChildWorkEvidence[] = []
  private readonly published = new Map<string, string>()
  private readonly settledCommands = new Set<string>()

  constructor(readonly threadId: string) {}

  owns(id: string): boolean {
    return id === this.threadId || this.agents.has(id)
  }

  register(id: string, parentId: string, label?: string, runId = `spawn:${id}`): void {
    if (id === this.threadId || !this.owns(parentId)) {
      return
    }
    const existing = this.agents.get(id)
    if (existing) {
      existing.label ??= label ? boundSubagentLabel(label) : undefined
      return
    }
    if (this.agents.size >= 256) {
      throw new Error('TRAE CLI child agent roster exceeded its bound')
    }
    this.agents.set(id, {
      id,
      parentId,
      ...(label ? { label: boundSubagentLabel(label) } : {}),
      runId,
      turnId: null,
      state: 'working',
      operation: null
    })
  }

  observe(method: string, value: unknown): void {
    const params = traexRecord(value)
    const thread = traexRecord(params.thread)
    if (method === 'thread/started') {
      const id = traexText(thread.id)
      const parent = traexText(thread.parentThreadId)
      if (id && parent) {
        this.register(id, parent, traexText(thread.agentNickname) ?? traexText(thread.name))
      }
      return
    }
    const threadId = traexText(params.threadId)
    if (!threadId || !this.owns(threadId)) {
      return
    }
    const item = traexRecord(params.item)
    const parsed = traexItemSchema.safeParse(params.item)
    if ((method === 'item/started' || method === 'item/completed') && parsed.success) {
      for (const child of traexChildAnnouncements(parsed.data)) {
        this.register(child.id, threadId, child.label, parsed.data.id)
        const agent = this.agents.get(child.id)
        const state = traexRecord(traexRecord(item.agentsStates)[child.id])
        const status = traexText(state.status)
        if (
          agent &&
          status &&
          ['completed', 'errored', 'shutdown', 'interrupted'].includes(status)
        ) {
          agent.state = 'done'
          agent.outcome =
            status === 'completed' ? 'succeeded' : status === 'errored' ? 'failed' : 'cancelled'
          agent.lastMessage = traexText(state.message) ?? agent.lastMessage
          agent.operation = null
        }
        this.publishAgent(child.id)
      }
      if (item.type === 'commandExecution' && item.source !== 'unifiedExecInteraction') {
        this.observeCommand(threadId, traexText(params.turnId) ?? null, parsed.data, method)
      }
    }
    const agent = this.agents.get(threadId)
    const turn = traexRecord(params.turn)
    const turnId = traexText(turn.id) ?? traexText(params.turnId)
    if (method === 'turn/started' && agent && turnId) {
      agent.runId = turnId
      agent.turnId = turnId
      agent.state = 'working'
      agent.outcome = undefined
      agent.lastMessage = undefined
      agent.operation = null
    } else if (method === 'turn/completed') {
      if (agent && (!turnId || agent.turnId === turnId)) {
        agent.state = 'done'
        agent.outcome =
          turn.status === 'completed'
            ? 'succeeded'
            : turn.status === 'failed'
              ? 'failed'
              : 'cancelled'
        agent.operation = null
      }
      for (const command of this.commands.values()) {
        if (command.threadId === threadId && (command.turnId === turnId || !command.turnId)) {
          command.background = true
          this.publishCommand(command)
        }
      }
    } else if (method === 'thread/closed' && agent) {
      agent.state = 'done'
      agent.outcome = 'cancelled'
      agent.operation = null
    } else if (method === 'queue/status' && agent && agent.state !== 'done') {
      agent.state = params.state === 'ready' ? 'working' : 'waiting'
    } else if (method === 'thread/status/changed' && agent && agent.state !== 'done') {
      const flags = traexRecord(params.status).activeFlags
      if (Array.isArray(flags)) {
        agent.state = flags.some(
          (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
        )
          ? 'waiting'
          : 'working'
      }
    } else if (method === 'thread/tokenUsage/updated' && agent) {
      const total = traexRecord(traexRecord(params.tokenUsage).total).totalTokens
      if (typeof total === 'number') {
        agent.totalTokens = total
      }
    } else if (agent && method === 'item/completed' && item.type === 'agentMessage') {
      agent.lastMessage = boundSubagentLabel(traexText(item.text) ?? traexContentText(item.content))
    }
    if (agent && ['item/started', 'item/completed'].includes(method)) {
      const tool =
        item.type === 'commandExecution'
          ? 'shell'
          : item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
            ? traexText(item.tool)
            : item.type === 'fileChange'
              ? 'apply_patch'
              : undefined
      if (tool) {
        agent.operation =
          method === 'item/completed'
            ? null
            : {
                toolName: tool,
                basis: 'open',
                observedAt: Date.now(),
                ...(item.type === 'commandExecution'
                  ? { input: boundSubagentLabel(traexText(item.command) ?? '') }
                  : {})
              }
      }
    }
    if (agent) {
      this.publishAgent(agent.id)
    }
  }

  terminals(threadId: string, processIds: readonly string[]): void {
    this.terminalSupport = 'supported'
    const running = new Set(processIds)
    for (const command of this.commands.values()) {
      if (command.threadId !== threadId || !command.processId) {
        continue
      }
      if (running.has(command.processId)) {
        command.background = true
        this.publishCommand(command)
        running.delete(command.processId)
      } else if (command.background) {
        this.endCommand(command.id)
      }
    }
    for (const processId of running) {
      const command: TraexChildCommand = {
        id: `traex-terminal:${JSON.stringify([threadId, processId])}`,
        threadId,
        turnId: null,
        processId,
        background: true
      }
      this.commands.set(command.id, command)
      this.publishCommand(command)
    }
  }

  descendants(id: string): string[] {
    const selected = new Set([id])
    for (let changed = true; changed;) {
      changed = false
      for (const child of this.agents.values()) {
        if (selected.has(child.parentId) && !selected.has(child.id)) {
          selected.add(child.id)
          changed = true
        }
      }
    }
    return [...selected]
  }

  drain(): AgentChildWorkEvidence[] {
    return this.pending.splice(0)
  }

  end(): void {
    this.pending.push({ type: 'session-ended', observedAt: Date.now() })
  }

  private observeCommand(
    threadId: string,
    turnId: string | null,
    item: TraexItem,
    method: string
  ): void {
    const id = `traex-command:${JSON.stringify([threadId, turnId, item.id])}`
    if (this.settledCommands.has(id)) {
      return
    }
    if (
      method === 'item/completed' &&
      item.status !== 'inProgress' &&
      item.status !== 'backgrounded'
    ) {
      this.endCommand(id)
      return
    }
    if (this.commands.size >= 512 && !this.commands.has(id)) {
      throw new Error('TRAE CLI command roster exceeded its bound')
    }
    const previous = this.commands.get(id)
    const commandText = traexText(item.command)?.replace(/\s+/g, ' ').trim()
    const command: TraexChildCommand = {
      id,
      threadId,
      turnId,
      processId: traexText(item.processId) ?? previous?.processId,
      description: boundSubagentLabel(
        commandText || previous?.description || traexText(item.description) || ''
      ),
      background: item.status === 'backgrounded' || previous?.background === true
    }
    this.commands.set(id, command)
    this.publishCommand(command)
  }

  private endCommand(id: string): void {
    if (this.commands.delete(id)) {
      this.pending.push({
        type: 'removed',
        observedAt: Date.now(),
        handle: { idKind: 'task_id', id }
      })
      this.published.delete(id)
    }
    this.settledCommands.add(id)
    if (this.settledCommands.size > 256) {
      this.settledCommands.delete(this.settledCommands.values().next().value!)
    }
  }

  private publishAgent(id: string): void {
    const agent = this.agents.get(id)
    if (agent) {
      this.publish(id, traexChildAgentEvidence(agent, this.threadId))
    }
  }

  private publishCommand(command: TraexChildCommand): void {
    this.publish(
      command.id,
      traexChildCommandEvidence(command, this.threadId, this.terminalSupport)
    )
  }

  private publish(id: string, event: AgentChildWorkEvidence): void {
    const fingerprint = JSON.stringify({ ...event, observedAt: undefined })
    if (this.published.get(id) !== fingerprint) {
      this.published.set(id, fingerprint)
      this.pending.push(event)
    }
  }
}
