import {
  registerReattachableProviderRelayAgent,
  type ProviderRelayWorkMarkers
} from '../../provider-relay/app-provider-relays'
import { createCodexRelayAckFloor } from './codex-relay-ack-floor'
import { CODEX_RELAY_ITEM_CONTINUATION } from './codex-relay-item-continuation'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'

/** Recorded with each Codex relay; this build reattaches it. */
export const CODEX_RELAY_AGENT = 'codex-app-server'
registerReattachableProviderRelayAgent(CODEX_RELAY_AGENT)

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
  agent: CODEX_RELAY_AGENT,
  ackFloor: createCodexRelayAckFloor,
  continuation: CODEX_RELAY_ITEM_CONTINUATION,
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

/** The kept agent's answer to the first app's `initialize`; callers only need it to resolve. */
export function keptInitializeResult(line: string | null): unknown {
  if (line === null) {
    return {}
  }
  try {
    const message: { result?: unknown } = JSON.parse(line)
    return message.result ?? {}
  } catch {
    return {}
  }
}

/** What a Codex connection exposes of its relayed app-server. */
export function codexConnectionRelay(
  child: Pick<RelayedProviderChild, 'releaseOutput' | 'attachResult' | 'handedOff'>,
  reattached: boolean
): NonNullable<CodexAppServerConnection['relay']> {
  return {
    reattached,
    releaseOutput: () => child.releaseOutput(),
    endedWork: () => child.attachResult?.endedWork,
    openWork: () => child.attachResult?.openWork,
    handedOff: () => child.handedOff
  }
}
