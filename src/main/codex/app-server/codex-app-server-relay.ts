import type { ProviderRelayWorkMarkers } from '../../provider-relay/app-provider-relays'

const THREAD = [
  ['params', 'threadId'],
  ['params', 'thread', 'id']
]
const COMMAND = { path: ['params', 'item', 'type'], is: 'commandExecution' }
/** A stdin write to a running command is not a process of its own (as the background tracker reads it). */
const NOT_INTERACTION = {
  path: ['params', 'item', 'source'],
  is: 'unifiedExecInteraction',
  not: true as const
}
const RUNNING = { path: ['params', 'item', 'status'], is: 'inProgress' }

/**
 * What the open app's idle stop counts for Codex: any thread's running turn (the chat's own and its
 * subagents') and every command process from its start until it completes, also after its turn ends.
 * Keys: `turn` [threadId], `command` [threadId, itemId].
 */
export const CODEX_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = {
  markers: [
    { group: 'turn', name: 'turn/started', effect: 'start', key: [THREAD] },
    { group: 'turn', name: 'turn/completed', effect: 'end', key: [THREAD] },
    { group: 'turn', name: 'thread/closed', effect: 'end', key: [THREAD] },
    {
      group: 'command',
      name: 'item/started',
      effect: 'start',
      when: [COMMAND, NOT_INTERACTION, RUNNING],
      key: [THREAD, [['params', 'item', 'id']]]
    },
    {
      group: 'command',
      name: 'item/started',
      effect: 'end',
      when: [COMMAND, { ...RUNNING, not: true }],
      key: [THREAD, [['params', 'item', 'id']]]
    },
    {
      group: 'command',
      name: 'item/completed',
      effect: 'end',
      when: [COMMAND],
      key: [THREAD, [['params', 'item', 'id']]]
    },
    // Codex stops a closed thread's processes first, so none of them reports its own end.
    { group: 'command', name: 'thread/closed', effect: 'end', key: [THREAD] }
  ]
}

/** True for an answer to a request this app sent (ids above the last app's), cheaply tested first. */
export function isCodexAnswerAbove(line: string, floor: number): boolean {
  if (!line.includes('"id"') || (!line.includes('"result"') && !line.includes('"error"'))) {
    return false
  }
  try {
    const message: unknown = JSON.parse(line)
    if (typeof message !== 'object' || message === null || 'method' in message) {
      return false
    }
    const { id } = message as { id?: unknown }
    return typeof id === 'number' && id > floor
  } catch {
    return false
  }
}

/** The kept agent's answer to the first app's `initialize`; callers only need it to resolve. */
export function keptInitializeResult(line: string | null): unknown {
  if (line === null) {
    return {}
  }
  try {
    const message = JSON.parse(line) as { result?: unknown }
    return message.result ?? {}
  } catch {
    return {}
  }
}
