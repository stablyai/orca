import type { TraexSession } from './traex-session'
import { traexItemSchema, traexRecord, traexText } from './traex-protocol'
import { TraexTimeline } from './traex-timeline'
import { TraexPromptRegistry } from './traex-prompt-registry'
import { isTraexTerminalActivity } from './traex-child-work'
import { refreshTraexBackgroundTerminals } from './traex-background-task-stops'
import { isAgentSessionInteractionMode } from '../../shared/agent-session/options/agent-session-interaction-mode'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'

export function observeTraexSessionNotification(
  session: TraexSession,
  method: string,
  value: unknown,
  logger?: StructuredAgentSessionLogger
): void {
  let params = traexRecord(value)
  if (
    params.threadId == null &&
    ['warning', 'guardianWarning', 'configWarning', 'deprecationNotice', 'hook/completed'].includes(
      method
    )
  ) {
    params = { ...params, threadId: session.threadId }
  }
  if (method === 'skills/changed') {
    void session
      .refreshCommands(true)
      .catch((error: unknown) =>
        logger?.warn('TRAE CLI skill refresh failed', { scope: 'traex-skills', error })
      )
    return
  }
  if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
    session.timeline?.observeGoal(method, params)
    return
  }
  session.childWork?.observe(method, params)
  const childId = traexText(params.threadId)
  if (childId && session.childWork?.agents.has(childId)) {
    observeTraexChildNotification(session, method, params, childId, logger)
    session.publishChildEvidence()
    return
  }
  if (params.threadId !== session.threadId) {
    session.publishChildEvidence()
    return
  }
  if (method === 'mode/changeRequested' && typeof params.requestId === 'string') {
    session.prompts?.handle({ id: params.requestId, method, params }, session.activeTurn)
    return
  }
  if (method === 'mode/changeResolved') {
    session.prompts?.withdraw(params.requestId)
    if (params.decision === 'approved' && isAgentSessionInteractionMode(params.targetMode)) {
      void session
        .updateMode(params.targetMode)
        .catch((error: unknown) =>
          session.fail(error instanceof Error ? error : new Error(String(error)))
        )
    }
    return
  }
  if (method === 'model/rerouted') {
    session.reportedModel = traexText(params.toModel)
  }
  if (method === 'model/fallback' && traexRecord(params.event).type === 'committed') {
    session.reportedModel = traexText(traexRecord(traexRecord(params.event).target).model)
  }
  const turn = traexRecord(params.turn)
  const turnId = traexText(params.turnId) ?? traexText(turn.id) ?? session.activeTurn
  if (session.compacting && (method === 'thread/compacted' || method === 'turn/completed')) {
    if (method === 'thread/compacted') {
      session.timeline?.notification(method, params, turnId)
    } else if (turnId) {
      session.timeline?.completeTurn(turn, turnId)
    }
    session.finishCompaction(turn.status === 'failed')
    return
  }
  if (method === 'turn/started' && turnId) {
    session.activeTurn = turnId
    if (!session.compacting) {
      session.timeline?.apply({ type: 'turn.open', turn: turnId, at: Date.now() })
    }
  } else if (method === 'turn/completed' && turnId) {
    session.timeline?.completeTurn(turn, turnId)
    session.noteCompletedTurn(turnId)
    session.timeline?.flush()
    session.timeline?.apply(
      {
        type: 'turn.end',
        turn: turnId,
        at: Date.now(),
        state: turn.status === 'interrupted' ? 'interrupted' : 'completed',
        outcome:
          turn.status === 'failed' ? 'failure' : turn.status === 'completed' ? 'success' : undefined
      },
      () => {
        if (session.activeTurn === turnId) {
          session.activeTurn = null
        }
      }
    )
  } else if ((method === 'item/started' || method === 'item/completed') && turnId) {
    const item = traexItemSchema.safeParse(params.item)
    const clientId = item.success ? (traexText(item.data.clientId) ?? item.data.id) : undefined
    const send = clientId ? session.pending.get(clientId) : undefined
    if (send && item.success && item.data.type === 'userMessage') {
      session.accept(send, turnId)
    }
    if (!session.compacting || (item.success && item.data.type === 'contextCompaction')) {
      session.timeline?.notification(method, params, turnId)
    }
  } else if (method === 'serverRequest/resolved') {
    session.prompts?.withdraw(params.requestId)
  } else {
    session.timeline?.notification(method, params, turnId)
  }
  session.publishChildEvidence()
  if (
    method === 'turn/completed' ||
    (method === 'item/completed' && isTraexTerminalActivity(params.item))
  ) {
    refreshTerminals(session, session.threadId!, logger)
  }
}

function observeTraexChildNotification(
  session: TraexSession,
  method: string,
  params: Record<string, unknown>,
  id: string,
  logger?: StructuredAgentSessionLogger
): void {
  const child = session.childWork!.agents.get(id)!
  let stream = session.childThreads.get(id)
  if (!stream) {
    const timeline = new TraexTimeline({
      sessionId: session.input.identity.sessionId,
      threadId: id,
      primaryThreadId: session.threadId!,
      generation: session.generation,
      sink: session.input.events!,
      fail: (error) => session.fail(error),
      producer: {
        agentId: id,
        producerKind: 'agent',
        ...(child.parentId !== session.threadId ? { parentAgentId: child.parentId } : {})
      }
    })
    stream = {
      timeline,
      prompts: new TraexPromptRegistry(session.connection, timeline, id),
      turnId: null
    }
    session.childThreads.set(id, stream)
  }
  const turn = traexRecord(params.turn)
  const turnId = traexText(params.turnId) ?? traexText(turn.id) ?? stream.turnId
  if (method === 'turn/started') {
    stream.turnId = turnId
  } else if (method === 'turn/completed') {
    if (turnId) {
      stream.timeline.completeTurn(turn, turnId)
    }
    stream.timeline.flush()
    stream.turnId = null
    refreshTerminals(session, id, logger)
  } else if (method === 'serverRequest/resolved') {
    stream.prompts.withdraw(params.requestId)
  } else if (method === 'mode/changeRequested' && typeof params.requestId === 'string') {
    stream.prompts.handle({ id: params.requestId, method, params }, turnId)
  } else if (method === 'mode/changeResolved') {
    stream.prompts.withdraw(params.requestId)
  } else {
    stream.timeline.notification(method, params, turnId)
  }
  if (method === 'item/completed' && isTraexTerminalActivity(params.item)) {
    refreshTerminals(session, id, logger)
  }
}

function refreshTerminals(
  session: TraexSession,
  id: string,
  logger?: StructuredAgentSessionLogger
): void {
  void refreshTraexBackgroundTerminals(session, id).catch((error: unknown) => {
    if (!session.requestedClose && !session.ended) {
      logger?.warn('TRAE CLI background terminals unavailable', {
        scope: 'traex-child-work',
        error
      })
    }
  })
}
