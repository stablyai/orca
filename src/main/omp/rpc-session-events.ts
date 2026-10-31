import { z } from 'zod'
import { OmpRpcSubagents } from './rpc-subagents'
import { OmpRpcBackgroundTasks } from './rpc-background-tasks'
import { OmpRpcSubagentMessages } from './rpc-subagent-messages'
import { ompEditResultEvents } from './rpc-edit-results'
import { ompTodoEvents } from './rpc-todo'
import { receiveOmpNotification } from './rpc-notifications'
import type { PiRpcSession } from '../pi/rpc-session'
import type { PiRpcSessionAdapterDeps } from '../pi/rpc-session-adapter'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

export const goalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'budget-limited', 'complete', 'dropped']),
  tokenBudget: z.number().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

const reportedGoals = new WeakMap<
  PiRpcSession,
  { snapshot: string; signature: string; item: string; occurrence: number }
>()
const subagents = new WeakMap<PiRpcSession, OmpRpcSubagents>()
const backgroundTasks = new WeakMap<PiRpcSession, OmpRpcBackgroundTasks>()
const subagentMessages = new WeakMap<PiRpcSession, OmpRpcSubagentMessages>()
const mappedTodoCalls = new WeakMap<PiRpcSession, Set<string>>()

export function captureOmpSubagentStop(session: PiRpcSession, id: string) {
  return subagents.get(session)?.captureStop(id)
}
const fileMentionSchema = z.looseObject({
  role: z.literal('fileMention'),
  files: z.array(z.looseObject({ path: z.string(), content: z.string() })),
  timestamp: z.number()
})

export function reportGoal(session: PiRpcSession, value: unknown): void {
  const parsed = goalSchema.nullable().safeParse(value)
  if (!parsed.success) {
    return
  }
  const goal = parsed.data
  const snapshot = JSON.stringify(goal)
  const previous = reportedGoals.get(session)
  if (previous?.snapshot === snapshot) {
    return
  }
  const signature = JSON.stringify([goal?.id, goal?.createdAt, goal?.objective, goal?.status])
  const accounting = previous?.signature === signature
  const occurrence = accounting ? previous.occurrence : (previous?.occurrence ?? 0) + 1
  const item = accounting
    ? previous.item
    : `omp-goal:${goal?.id ?? 'cleared'}:${goal?.updatedAt ?? Date.now()}:${occurrence}`
  reportedGoals.set(session, { snapshot, signature, item, occurrence })
  if (previous === undefined && goal === null) {
    return
  }
  session.lane.apply([
    {
      type: accounting ? 'item.update' : 'item.close',
      item,
      body: {
        kind: 'status',
        text: goal ? `Goal: ${goal.objective} (${goal.status})` : 'Goal cleared',
        threadGoal:
          goal && goal.status !== 'dropped'
            ? {
                state: 'set',
                goal: {
                  objective: goal.objective,
                  status: goal.status === 'budget-limited' ? 'budgetLimited' : goal.status,
                  tokenBudget: goal.tokenBudget ?? null,
                  tokensUsed: goal.tokensUsed,
                  timeUsedSeconds: goal.timeUsedSeconds,
                  createdAt: goal.createdAt,
                  updatedAt: goal.updatedAt
                }
              }
            : { state: 'cleared' }
      }
    }
  ])
}

export function receiveOmpFrame(
  frame: JsonlRpcRecord,
  session: PiRpcSession,
  logger: PiRpcSessionAdapterDeps['logger'],
  supportsSubagentStop: () => boolean = () => false
): boolean {
  let transcripts = subagentMessages.get(session)
  if (!transcripts) {
    transcripts = new OmpRpcSubagentMessages(session.generation)
    subagentMessages.set(session, transcripts)
  }
  const transcriptEvents = transcripts.receive(frame)
  if (transcriptEvents.length > 0) {
    session.lane.apply(transcriptEvents)
  }
  if (frame.type === 'subagent_event') {
    return true
  }
  const todoEdits = ompTodoEvents(frame)
  const todoCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : undefined
  let mappedTodos = mappedTodoCalls.get(session)
  if (frame.type === 'tool_execution_start' && todoCallId && todoEdits.length > 0) {
    mappedTodos ??= new Set<string>()
    mappedTodoCalls.set(session, mappedTodos)
    mappedTodos.add(todoCallId)
  }
  const mappedTodoUpdate =
    todoCallId !== undefined &&
    mappedTodos?.has(todoCallId) === true &&
    frame.type === 'tool_execution_update'
  const mappedTodoStart =
    todoCallId !== undefined &&
    mappedTodos?.has(todoCallId) === true &&
    frame.type === 'tool_execution_start'
  const mappedTodoEnd =
    todoCallId !== undefined &&
    mappedTodos?.has(todoCallId) === true &&
    frame.type === 'tool_execution_end'
  const edits = [...ompEditResultEvents(frame), ...todoEdits]
  let tasks = backgroundTasks.get(session)
  if (!tasks) {
    tasks = new OmpRpcBackgroundTasks()
    backgroundTasks.set(session, tasks)
  }
  const taskEvidence = tasks.receive(frame)
  if (taskEvidence.length > 0) {
    session.lane.childWork(taskEvidence)
  }
  if (receiveOmpNotification(frame, session)) {
    return true
  }
  if (mappedTodoUpdate) {
    return true
  }
  if (frame.type === 'message_start' || frame.type === 'message_end') {
    const mention = fileMentionSchema.safeParse(frame.message)
    if (mention.success) {
      session.turns.receive({ ...frame, message: { ...mention.data, content: [] } })
      return true
    }
  }
  let children = subagents.get(session)
  if (!children) {
    children = new OmpRpcSubagents(
      (message) =>
        logger.warn(message, {
          scope: 'omp-rpc-subagents',
          sessionId: session.input.identity.sessionId
        }),
      supportsSubagentStop
    )
    subagents.set(session, children)
  }
  const evidence = children.receive(frame)
  if (evidence) {
    session.lane.childWork(evidence)
    return true
  }
  if (frame.type === 'goal_updated') {
    reportGoal(session, frame.goal)
    return true
  }
  if (frame.type === 'omp_state') {
    if (
      session.openedLink &&
      z.object({ sessionFile: z.string() }).parse(frame.state).sessionFile !== session.sessionFile
    ) {
      session.fail(
        new Error(
          'OMP changed its session file outside Orca. Reopen the target conversation explicitly.'
        )
      )
      return true
    }
    const state = z
      .object({ goal: z.object({ goal: goalSchema }).nullable() })
      .safeParse(frame.state)
    if (state.success) {
      reportGoal(session, state.data.goal?.goal ?? null)
    }
    return true
  }
  if (frame.type === 'prompt_result') {
    const result = z
      .object({
        status: z.enum(['completed', 'aborted', 'error']),
        error: z.object({ message: z.string() }).optional(),
        sessionSettled: z.boolean()
      })
      .parse(frame)
    session.turns.reportPromptOutcome(
      result.status === 'error'
        ? 'failure'
        : result.status === 'aborted'
          ? 'cancellation'
          : 'success',
      result.error?.message
    )
    if (result.sessionSettled) {
      session.turns.commandCompleted()
    }
    return true
  }
  if (frame.type === 'available_commands_update') {
    void session.startup.readCommands()
    return true
  }

  if (edits.length > 0) {
    if (!mappedTodoStart && !mappedTodoEnd) {
      session.turns.receive(frame)
    }
    session.lane.apply(edits)
    if (frame.type === 'tool_execution_end' && todoCallId && mappedTodos) {
      mappedTodos.delete(todoCallId)
    }
    return true
  }
  if (frame.type === 'tool_execution_end' && todoCallId && mappedTodos) {
    mappedTodos.delete(todoCallId)
  }
  return false
}
