import {
  registerReattachableProviderRelayAgent,
  type ProviderRelayWorkMarkers
} from '../../provider-relay/app-provider-relays'
import { createCodexRelayAckFloor } from './codex-relay-ack-floor'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { leadingJsonEnvelope } from '../../../shared/json-stream/json-rpc-record-prefix'

const ENVELOPE_SCAN_CHARS = 4096
const ENVELOPE_MAX_FIELDS = 32

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

/** True for an answer to a request this app sent (ids above the last app's), read from its envelope. */
export function isCodexAnswerAbove(line: string, floor: number): boolean {
  if (!line.includes('"id"') || (!line.includes('"result"') && !line.includes('"error"'))) {
    return false
  }
  const { properties, complete } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: ENVELOPE_MAX_FIELDS
  })
  const keys = new Set(properties.map((property) => property.key))
  if (complete && keys.size === properties.length) {
    const id = properties.find((property) => property.key === 'id')?.value
    return (
      !keys.has('method') &&
      (keys.has('result') || keys.has('error')) &&
      typeof id === 'number' &&
      id > floor
    )
  }
  // Cut off or with a repeated key: only a full parse reads it as the connection will.
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

/** What a Codex connection exposes of its relayed app-server. */
export function codexConnectionRelay(
  child: Pick<RelayedProviderChild, 'releaseOutput' | 'attachResult'>,
  reattached: boolean
): NonNullable<CodexAppServerConnection['relay']> {
  return {
    reattached,
    releaseOutput: () => child.releaseOutput(),
    endedWork: () => child.attachResult?.endedWork
  }
}
