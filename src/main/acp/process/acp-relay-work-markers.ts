import type { ProviderRelayWorkMarker } from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  registerReattachableProviderRelayAgent,
  type ProviderRelayWorkMarkers
} from '../../provider-relay/app-provider-relays'
import { ACP_SESSION_UPDATE_METHODS } from './acp-session-update-fields'

/**
 * These launch as today: a private temp folder is the launch's own and goes at its exit; a sign-in
 * link (Gemini's) is read from stderr as it arrives, which a relay only sends at exit.
 */
export function acpSpecRelays(
  spec: Pick<AcpLaunchSpec, 'privateTempDirectory' | 'signIn'>
): boolean {
  return !spec.privateTempDirectory && !spec.signIn
}

/** Recorded with each ACP relay, per agent, so a build can stop relaying one and still end its relay. */
const acpRelayAgent = (agent: string): string => `acp:${agent}`

/** Each ACP agent this build relays reattaches; called as its adapter is registered. */
export function registerAcpRelayAgent(spec: AcpLaunchSpec): void {
  if (acpSpecRelays(spec)) {
    // An agent that ended while Orca was closed opens once, to show its unread output; its chats
    // may be kept, so an open never settles their run as gone before the reattach.
    registerReattachableProviderRelayAgent(acpRelayAgent(spec.agent), {
      opensEnded: true,
      provider: spec.agent
    })
  }
}

/** An ACP turn is the app's own `session/prompt` request; no agent line opens it. */
const PROMPT_REQUESTS = ['session/prompt']

const UPDATE = ['params', 'update']
const GROK_SESSION_UPDATES = [...ACP_SESSION_UPDATE_METHODS]
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
 * A call Orca turned into a background task at its turn's end (Qwen Code, CodeBuddy) ends with the
 * call's own final update. Droid closes a backgrounded subagent's call while the subagent still
 * runs, so subagents never end this way: such an agent is kept rather than stopped early.
 */
const CALL_END_MARKERS: ProviderRelayWorkMarker[] = ['completed', 'failed'].map((status) => ({
  group: 'task',
  name: 'session/update',
  effect: 'end',
  when: [kind('tool_call_update'), { path: [...UPDATE, 'status'], is: status }],
  key: keyAt('toolCallId')
}))

/** OpenCode's subagents are child sessions, opened and closed by their status reports. */
const OPENCODE_CHILD_STATUS: [string, 'start' | 'end'][] = [
  ['created', 'start'],
  ['running', 'start'],
  ['completed', 'end'],
  ['failed', 'end'],
  ['interrupted', 'end']
]
const OPENCODE_MARKERS: ProviderRelayWorkMarker[] = both('opencode/session/child_update').flatMap(
  (name) =>
    OPENCODE_CHILD_STATUS.map(([status, effect]) => ({
      group: 'subagent',
      name,
      effect,
      when: [
        { path: ['params', 'type'], is: 'status' },
        { path: ['params', 'status'], is: status }
      ],
      key: [[['params', 'childSessionId']]]
    }))
)

const DIALECT_MARKERS = new Map<string, ProviderRelayWorkMarker[]>([
  ['grok', GROK_MARKERS],
  ['opencode', OPENCODE_MARKERS],
  ['opencode2', OPENCODE_MARKERS]
])

/**
 * What the open app's idle stop counts for an ACP chat while no app is attached: its prompt, and
 * the background tasks and subagents the agent reports: a call's final update ends a task keyed by
 * its call id, and Grok's and OpenCode's own task and subagent lines open and close the others.
 */
export function acpRelayWorkMarkers(agent: string): ProviderRelayWorkMarkers {
  return {
    agent: acpRelayAgent(agent),
    markers: [...CALL_END_MARKERS, ...(DIALECT_MARKERS.get(agent) ?? [])],
    requests: PROMPT_REQUESTS
  }
}

/** Work only the agent knows of; nothing ends it, so its agent is never idle-stopped while kept. */
export const ACP_UNKNOWN_WORK = 'unknown'

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
