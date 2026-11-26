import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../shared/agent-session/view/agent-session-goal-control-copy'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { TraexSession } from './traex-session'
import { installTraexExecutionSettings } from './traex-execution-settings'
import { traexRecord, TraexRequestError } from './traex-protocol'

export async function readTraexThreadGoal(session: TraexSession): Promise<void> {
  const result = traexRecord(
    await session.connection.request('thread/goal/get', { threadId: session.threadId! })
  )
  if (!Object.hasOwn(result, 'goal')) {
    throw new Error('TRAE CLI did not report thread goal state')
  }
  session.timeline?.observeGoal(
    result.goal == null ? 'thread/goal/cleared' : 'thread/goal/updated',
    {
      threadId: session.threadId,
      goal: result.goal
    }
  )
}

export async function changeTraexThreadGoal(
  session: TraexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>[0]
): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const starts =
    input.change.kind === 'set' ||
    (input.change.kind === 'status' && input.change.status === 'active')
  if (starts) {
    try {
      await installTraexExecutionSettings(
        session,
        { ...session.options, ...input.executionOptions },
        input.signal
      )
    } catch {
      return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.settingsUnconfirmed }
    }
  }
  input.signal?.throwIfAborted()
  if (session.ended || session.input.fence !== input.fence) {
    throw new Error('TRAE CLI goal acquisition ended')
  }
  const change = input.change
  const method = change.kind === 'clear' ? 'thread/goal/clear' : 'thread/goal/set'
  const params =
    change.kind === 'set'
      ? { objective: change.objective, status: 'active', replace: input.replacesGoal }
      : change.kind === 'status'
        ? { status: change.status }
        : {}
  let response: unknown
  try {
    response = await session.connection.request(method, { threadId: session.threadId!, ...params })
  } catch (error) {
    if (!(error instanceof TraexRequestError)) {
      throw error
    }
    if (change.kind === 'status') {
      const read = traexRecord(
        await session.connection.request('thread/goal/get', { threadId: session.threadId! })
      )
      if (read.goal === null) {
        return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.noGoal }
      }
    }
    return { ok: false, rejected: error.message }
  }
  if (change.kind === 'clear' && traexRecord(response).cleared === false) {
    return { ok: false, rejected: AGENT_SESSION_GOAL_CONTROL_COPY.noGoal }
  }
  await readTraexThreadGoal(session)
  return { ok: true }
}

export async function pauseTraexThreadGoal(session: TraexSession): Promise<boolean> {
  const result = traexRecord(
    await session.connection.request(
      'thread/goal/get',
      { threadId: session.threadId! },
      { timeoutMs: 5_000 }
    )
  )
  if (!Object.hasOwn(result, 'goal')) {
    throw new Error('TRAE CLI did not report thread goal state')
  }
  if (traexRecord(result.goal).status === 'active') {
    await session.connection.request(
      'thread/goal/set',
      { threadId: session.threadId!, status: 'paused' },
      { timeoutMs: 5_000 }
    )
    return true
  }
  return false
}
