import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { TraexSession } from './traex-session'
import { traexRecord, TraexRequestError } from './traex-protocol'

const reads = new WeakMap<TraexSession, Map<string, Promise<void>>>()

export function refreshTraexBackgroundTerminals(
  session: TraexSession,
  threadId: string
): Promise<void> {
  if (session.ended || !session.childWork?.owns(threadId)) {
    return Promise.resolve()
  }
  const pending = reads.get(session) ?? new Map<string, Promise<void>>()
  reads.set(session, pending)
  const existing = pending.get(threadId)
  if (existing) {
    return existing
  }
  const work = (async () => {
    try {
      const response = traexRecord(
        await session.connection.request(
          'thread/backgroundTerminals/list',
          { threadId },
          { timeoutMs: 5_000 }
        )
      )
      if (
        !Array.isArray(response.processIds) ||
        !response.processIds.every((id) => typeof id === 'string')
      ) {
        throw new Error('TRAE CLI did not report background terminal identities')
      }
      if (!session.ended) {
        session.childWork!.terminals(threadId, response.processIds)
        session.publishChildEvidence()
        session.input.events?.publish()
      }
    } catch (error) {
      if (error instanceof TraexRequestError && error.code === -32601) {
        session.childWork!.terminalSupport = 'unsupported'
        session.input.events?.publish()
        return
      }
      throw error
    }
  })().finally(() => pending.delete(threadId))
  pending.set(threadId, work)
  return work
}

export async function stopTraexBackgroundTasks(
  session: TraexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>[0]
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const work = session.childWork
  if (!work) {
    return { cancelled: false }
  }
  const check = () => {
    if (session.ended || session.connection.closed || session.input.fence !== input.fence) {
      throw new Error('TRAE CLI child work acquisition ended')
    }
  }
  const selected = new Set(input.taskIds)
  const agents = new Map<string, { turnId: string | null; runId: string }>()
  for (const id of selected) {
    if (!work.agents.has(id)) {
      continue
    }
    for (const descendant of work.descendants(id)) {
      const agent = work.agents.get(descendant)
      if (agent && agent.state !== 'done') {
        agents.set(descendant, { turnId: agent.turnId, runId: agent.runId })
      }
    }
  }
  if (work.terminalSupport === 'supported') {
    await Promise.all([...agents.keys()].map((id) => refreshTraexBackgroundTerminals(session, id)))
    check()
  }
  const terminals = [...work.commands.values()].filter(
    (command) => command.processId && (selected.has(command.id) || agents.has(command.threadId))
  )
  let cancelled = false
  let stillRunning = false
  for (const [id, captured] of agents) {
    check()
    if (work.agents.get(id)?.runId !== captured.runId) {
      continue
    }
    await session.connection.request(
      captured.turnId ? 'turn/interrupt' : 'thread/agent/close',
      captured.turnId
        ? { threadId: id, turnId: captured.turnId }
        : { threadId: session.threadId, targetAgentThreadId: id },
      { timeoutMs: 5_000 }
    )
    check()
    cancelled = true
    input.acknowledge?.({ taskId: id, outcome: 'cancelled' })
    session.childThreads.get(id)?.prompts.withdraw()
  }
  for (const command of terminals) {
    check()
    if (work.commands.get(command.id) !== command || work.terminalSupport !== 'supported') {
      continue
    }
    const result = traexRecord(
      await session.connection.request(
        'thread/backgroundTerminals/stop',
        { threadId: command.threadId, processId: command.processId },
        { timeoutMs: 5_000 }
      )
    )
    if (result.outcome !== 'terminationRequested' && result.outcome !== 'alreadyExited') {
      throw new Error('TRAE CLI did not confirm the background terminal stop')
    }
    await refreshTraexBackgroundTerminals(session, command.threadId)
    check()
    if (work.commands.has(command.id)) {
      stillRunning = true
    } else {
      cancelled = true
      input.acknowledge?.({
        taskId: command.id,
        outcome: result.outcome === 'alreadyExited' ? 'unknown' : 'cancelled'
      })
    }
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
