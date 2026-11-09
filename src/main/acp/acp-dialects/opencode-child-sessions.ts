// OpenCode reports each subagent as a child session once the client opts in (2.x recordings).

import { z } from 'zod'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'
import { readAcpSessionEvent } from '../protocol/acp-session-events'
import type { AcpDialectNotification } from './acp-dialect'

export const OPENCODE_CHILD_SESSION_CAPABILITY = 'opencode/child-session-updates'
const CHILD_UPDATE_METHOD = 'opencode/session/child_update'

const idSchema = z.string().trim().min(1)
const childSchema = z.looseObject({
  rootSessionId: idSchema,
  childSessionId: idSchema,
  parentSessionId: idSchema,
  title: z.string().optional().catch(undefined),
  _meta: z.looseObject({ isReplay: z.boolean().optional() }).nullish().catch(undefined)
})
const statusSchema = childSchema.extend({ type: z.literal('status'), status: z.string() })
const frameSchema = childSchema.extend({
  type: z.literal('update'),
  update: z.looseObject({ sessionUpdate: z.string() })
})

// Map lookups avoid treating __proto__ as a recognized state.
const CHILD_STATES: ReadonlyMap<string, NativeChatSubagentState> = new Map([
  ['created', 'working'],
  ['running', 'working'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['interrupted', 'stopped']
] satisfies [string, NativeChatSubagentState][])

// OpenCode prefixes a child's tool titles with the child's title; its own section names it already.
function ownTitle<T extends { sessionUpdate: string }>(update: T, title: string | undefined): T {
  const prefix = title ? `${title}: ` : undefined
  return prefix &&
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    'title' in update &&
    typeof update.title === 'string' &&
    update.title.startsWith(prefix)
    ? { ...update, title: update.title.slice(prefix.length) }
    : update
}

/** A child's status or one of its own frames; nested children name their parent child. */
export function openCodeChildUpdate(
  method: string,
  params: unknown
): AcpDialectNotification | undefined {
  if (method.replace(/^_/, '') !== CHILD_UPDATE_METHOD) {
    return undefined
  }
  const parsed = childSchema.safeParse(params)
  if (!parsed.success) {
    return { disposition: 'ignore' }
  }
  const { rootSessionId, childSessionId, parentSessionId, title, _meta } = parsed.data
  const label = title?.trim()
  const identity = {
    rootSessionId,
    agentId: childSessionId,
    ...(parentSessionId === rootSessionId ? {} : { parentAgentId: parentSessionId }),
    ...(label ? { label } : {})
  }
  const replay = _meta?.isReplay === true ? { replay: true } : {}
  const status = statusSchema.safeParse(params)
  if (status.success) {
    const state = CHILD_STATES.get(status.data.status)
    const started = status.data.status === 'running' ? { started: true as const } : {}
    return state
      ? { disposition: 'map', ...replay, child: { ...identity, state, ...started } }
      : { disposition: 'ignore' }
  }
  const frame = frameSchema.safeParse(params)
  const event = frame.success
    ? readAcpSessionEvent({ sessionId: rootSessionId, update: ownTitle(frame.data.update, title) })
    : null
  return event?.kind === 'known'
    ? { disposition: 'map', ...replay, child: { ...identity, update: event.notification } }
    : { disposition: 'ignore' }
}
