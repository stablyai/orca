import {
  registerReattachableProviderRelayAgent,
  type ProviderRelayWorkMarkers
} from '../../provider-relay/app-provider-relays'
import type { ProviderRelayAttachResult } from '../../daemon/protocol/daemon-provider-relay-protocol'
import { claudeRelayAckFloor } from './claude-relay-ack-floor'
import {
  CLAUDE_RELAY_ITEM_CONTINUATION,
  CLAUDE_TERMINAL_TASK_STATUSES
} from './claude-relay-continuation'

/** Recorded with each Claude relay; this build reattaches it. */
export const CLAUDE_RELAY_AGENT = 'claude-code'
registerReattachableProviderRelayAgent(CLAUDE_RELAY_AGENT)

const SESSION = [['session_id']]
const TASK = [['task_id']]
const subtype = (is: string) => ({ path: ['subtype'], is })
const state = (is: string) => ({ path: ['state'], is })

/**
 * What the open app's idle stop counts for Claude: the running turn (from Claude's own session
 * state, closed by its result too) and every background task the agent reports, from its start
 * until its end, also after the turn. Keys: `turn` [session_id], `task` [task_id].
 */
export const CLAUDE_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = {
  agent: CLAUDE_RELAY_AGENT,
  ackFloor: claudeRelayAckFloor,
  continuation: CLAUDE_RELAY_ITEM_CONTINUATION,
  // The CLI's keep-alive while a request is open, every 30 s; the SDK only reads a startup mark off it.
  quiet: ['keep_alive'],
  markers: [
    {
      group: 'turn',
      name: 'system',
      effect: 'start',
      when: [subtype('session_state_changed'), state('running')],
      key: [SESSION]
    },
    {
      group: 'turn',
      name: 'system',
      effect: 'end',
      when: [subtype('session_state_changed'), state('idle')],
      key: [SESSION]
    },
    { group: 'turn', name: 'result', effect: 'end', key: [SESSION] },
    {
      group: 'task',
      name: 'system',
      effect: 'start',
      when: [subtype('task_started')],
      key: [TASK]
    },
    {
      group: 'task',
      name: 'system',
      effect: 'end',
      when: [subtype('task_notification')],
      key: [TASK]
    },
    ...CLAUDE_TERMINAL_TASK_STATUSES.map((status) => ({
      group: 'task',
      name: 'system',
      effect: 'end' as const,
      when: [subtype('task_updated'), { path: ['patch', 'status'], is: status }],
      key: [TASK]
    })),
    {
      group: 'task',
      name: 'system',
      effect: 'roster',
      when: [subtype('background_tasks_changed')],
      list: ['tasks'],
      key: [TASK]
    }
  ]
}

/** Background tasks open when the last app let go, and those that ended since, from an attach. */
export function claudeRelayAttachTaskIds(
  attach: Pick<ProviderRelayAttachResult, 'openWork' | 'endedWork'> | null
): string[] {
  const work = [...(attach?.openWork?.task ?? []), ...(attach?.endedWork?.task ?? [])]
  return [...new Set(work.flatMap(([id]) => id ?? []))]
}

/** The chat's open work for a detached idle stop, keyed as `CLAUDE_RELAY_WORK_MARKERS` key it. */
export function claudeRelayOpenWork(
  session: { providerSessionId: string; childWork: { live: ReadonlyMap<string, unknown> } },
  rootTurnRunning: boolean
): Record<string, string[][]> {
  return {
    turn: rootTurnRunning ? [[session.providerSessionId]] : [],
    task: [...session.childWork.live.keys()].map((taskId) => [taskId])
  }
}
