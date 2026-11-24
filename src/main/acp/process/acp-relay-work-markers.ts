import type { ProviderRelayWorkMarker } from '../../daemon/protocol/daemon-provider-relay-protocol'
import {
  registerReattachableProviderRelayAgent,
  type ProviderRelayWorkMarkers
} from '../../provider-relay/app-provider-relays'

/** Recorded with each ACP relay; this build reattaches it. */
const ACP_RELAY_AGENT = 'acp-agent'
registerReattachableProviderRelayAgent(ACP_RELAY_AGENT)

/** An ACP turn is the app's own `session/prompt` request; no agent line opens it. */
const PROMPT_REQUESTS = ['session/prompt']

const UPDATE = ['params', 'update']
const GROK_SESSION_UPDATES = [
  'session/update',
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update'
]
const both = (method: string): string[] => [method, `_${method}`]
const keyAt = (...path: string[]): string[][][] => [[[...UPDATE, ...path]]]
const kind = (sessionUpdate: string) => ({ path: [...UPDATE, 'sessionUpdate'], is: sessionUpdate })
const rawOutput = (type: string) => ({ path: [...UPDATE, 'rawOutput', 'type'], is: type })

/**
 * Grok's background tasks and subagents, as its dialect reads them: a task opens when a call
 * reports it started or the agent says it was backgrounded, and closes when the agent says it
 * completed; a subagent opens when spawned and closes when finished. A close Grok reports only
 * inside a call's result keeps the task open, so the agent is kept rather than stopped early.
 */
const GROK_MARKERS: ProviderRelayWorkMarker[] = [
  {
    group: 'task',
    name: 'session/update',
    effect: 'start',
    when: [rawOutput('BackgroundTaskStarted')],
    key: keyAt('rawOutput', 'task_id')
  },
  ...both('x.ai/task_backgrounded').map((name) => ({
    group: 'task',
    name,
    effect: 'start' as const,
    key: keyAt('task_id')
  })),
  ...both('x.ai/task_completed').map((name) => ({
    group: 'task',
    name,
    effect: 'end' as const,
    key: keyAt('task_snapshot', 'task_id')
  })),
  ...GROK_SESSION_UPDATES.flatMap((name) => [
    {
      group: 'subagent',
      name,
      effect: 'start' as const,
      when: [kind('subagent_spawned')],
      key: keyAt('subagent_id')
    },
    {
      group: 'subagent',
      name,
      effect: 'end' as const,
      when: [kind('subagent_finished')],
      key: keyAt('subagent_id')
    }
  ]),
  {
    group: 'subagent',
    name: 'session/update',
    effect: 'end',
    when: [rawOutput('SubagentCompleted')],
    key: keyAt('rawOutput', 'subagent_id')
  }
]

/**
 * A call Orca or the dialect turned into a background task or subagent (keyed by its call id, as
 * Qwen Code, CodeBuddy and Droid are) ends with the call's own final update.
 */
const CALL_END_MARKERS: ProviderRelayWorkMarker[] = ['task', 'subagent'].flatMap((group) =>
  ['completed', 'failed'].map((status) => ({
    group,
    name: 'session/update',
    effect: 'end' as const,
    when: [kind('tool_call_update'), { path: [...UPDATE, 'status'], is: status }],
    key: keyAt('toolCallId')
  }))
)

/**
 * What the open app's idle stop counts for an ACP chat while no app is attached: its prompt, and
 * the background tasks and subagents the agent reports: a call's final update ends one keyed by
 * its call id, and Grok's own task and subagent lines open and close its others.
 */
export function acpRelayWorkMarkers(agent: string): ProviderRelayWorkMarkers {
  return {
    agent: ACP_RELAY_AGENT,
    markers: [...CALL_END_MARKERS, ...(agent === 'grok' ? GROK_MARKERS : [])],
    requests: PROMPT_REQUESTS
  }
}

/** The background tasks and subagents a chat holds open at detach, keyed as the markers key them. */
export function acpRelayOpenWork(open: {
  tasks: readonly string[]
  subagents: readonly string[]
}): Record<string, string[][]> {
  return {
    task: open.tasks.map((id) => [id]),
    subagent: open.subagents.map((id) => [id])
  }
}
