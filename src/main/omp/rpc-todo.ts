import { z } from 'zod'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { ompNativeToolResults } from './rpc-tool-results'

const taskSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']),
  blocker: z.string().optional()
})
const phaseSchema = z.object({ name: z.string().min(1), tasks: z.array(taskSchema) })

type OmpPlan = {
  plan: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]
  explanation?: string
}

const todoInputEntrySchema = z.object({
  phase: z.string().optional(),
  items: z.array(z.string().min(1)).optional()
})

/** Build the best task snapshot available before OMP commits the tool result. */
export function ompTodoInputPlan(input: unknown): OmpPlan | null {
  const parsed = z
    .object({
      op: z.string(),
      items: z.array(z.string().min(1)).optional(),
      list: z.array(todoInputEntrySchema).optional(),
      phase: z.string().optional()
    })
    .safeParse(input)
  if (!parsed.success || !['init', 'append'].includes(parsed.data.op)) {
    return null
  }
  const entries = parsed.data.list?.flatMap((entry) => {
    const phase = entry.phase?.trim() || parsed.data.phase?.trim() || 'Todo'
    return (entry.items ?? []).map((item) => ({ phase, item }))
  })
  const items =
    entries && entries.length > 0
      ? entries
      : (parsed.data.items ?? []).map((item) => ({
          phase: parsed.data.phase?.trim() || 'Todo',
          item
        }))
  if (items.length === 0) {
    return null
  }
  const phases = [...new Set(items.map(({ phase }) => phase))]
  return {
    plan: items.map(({ phase, item }) => ({ step: `${phase}: ${item}`, status: 'pending' })),
    ...(phases.length > 0 ? { explanation: `OMP phases: ${phases.join(' · ')}` } : {})
  }
}

function normalizedPlan(details: Record<string, unknown>, toolName?: string): OmpPlan | null {
  for (const result of ompNativeToolResults(details, toolName)) {
    if (result.toolName !== 'todo' && !result.returned) {
      continue
    }
    const phases = z.array(phaseSchema).safeParse(result.details.phases)
    if (!phases.success) {
      continue
    }
    const plan = phases.data.flatMap((phase) =>
      phase.tasks.map((task) => ({
        step: `${phase.name}: ${task.content}${
          task.status === 'blocked'
            ? ` (blocked${task.blocker ? `: ${task.blocker}` : ''})`
            : task.status === 'abandoned'
              ? ' (abandoned)'
              : ''
        }`,
        status:
          task.status === 'completed'
            ? ('completed' as const)
            : task.status === 'in_progress'
              ? ('in_progress' as const)
              : ('pending' as const)
      }))
    )
    const explanation = phases.data
      .map((phase) => phase.name)
      .filter(Boolean)
      .join(' · ')
    return { plan, ...(explanation ? { explanation: `OMP phases: ${explanation}` } : {}) }
  }
  return null
}

export function ompTodoEvents(frame: JsonlRpcRecord): ProviderTimelineEvent[] {
  if (
    frame.type === 'tool_execution_start' &&
    frame.toolName === 'todo' &&
    typeof frame.toolCallId === 'string'
  ) {
    const plan = ompTodoInputPlan(frame.args)
    return plan
      ? [
          {
            type: 'item.open',
            item: `tool:${frame.toolCallId}`,
            body: {
              kind: 'tool-call',
              name: 'update_plan',
              input: plan,
              callId: frame.toolCallId,
              state: 'running'
            }
          }
        ]
      : []
  }
  if (
    frame.type !== 'tool_execution_end' ||
    frame.isError === true ||
    typeof frame.toolCallId !== 'string'
  ) {
    return []
  }
  const result = z.object({ details: z.record(z.string(), z.unknown()) }).safeParse(frame.result)
  if (!result.success) {
    return []
  }
  const plan = normalizedPlan(
    result.data.details,
    typeof frame.toolName === 'string' ? frame.toolName : undefined
  )
  return plan
    ? [
        {
          type: 'item.close',
          item: `tool:${frame.toolCallId}`,
          body: {
            kind: 'tool-call',
            name: 'update_plan',
            input: plan,
            callId: frame.toolCallId,
            state: 'completed'
          }
        }
      ]
    : []
}

export function ompHistoricalTodoBlocks(details: unknown, toolName?: string): NativeChatBlock[] {
  const parsed = z.record(z.string(), z.unknown()).safeParse(details)
  if (!parsed.success) {
    return []
  }
  const plan = normalizedPlan(parsed.data, toolName)
  return plan ? [{ type: 'tool-call', name: 'update_plan', input: plan, state: 'completed' }] : []
}
