import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { opensNewTurn } from '../../../shared/agent-hook-cancel-verdict-latch'
import { isNewTurnEvent } from '../../../shared/agent-hook-listener/provider-event-routing'
import {
  isSameAgentProcess,
  readAgentProcessIdentity,
  type AgentProcessIdentity
} from '../../../shared/agent-process-presence'

/** All pane aliases share the same exit evidence. */
export type AgentExitEvidence = {
  at: number
  paneKeys: Set<string>
  agent?: string
  process?: AgentProcessIdentity
}

export type PersistedAgentExitEvidence = {
  at: number
  paneKeys: string[]
  agent?: string
  process?: AgentProcessIdentity
}

type EndedAgent = { agent?: string; process?: AgentProcessIdentity }

export function recordAgentExit(
  exits: Map<string, AgentExitEvidence>,
  paneKeys: Iterable<string>,
  ended: EndedAgent | undefined,
  at = Date.now()
): void {
  const exit: AgentExitEvidence = {
    at,
    paneKeys: new Set(paneKeys),
    ...(ended?.agent ? { agent: ended.agent } : {}),
    ...(ended?.process ? { process: ended.process } : {})
  }
  for (const key of exit.paneKeys) {
    forgetAgentExit(exits, key)
  }
  for (const key of exit.paneKeys) {
    exits.set(key, exit)
  }
}

/** Forget every alias of the exit, not just this key. */
export function forgetAgentExit(exits: Map<string, AgentExitEvidence>, paneKey: string): boolean {
  const exit = exits.get(paneKey)
  for (const key of exit?.paneKeys ?? []) {
    exits.delete(key)
  }
  return exit !== undefined
}

export function claimsPaneAfterExit(
  event: AgentHookEventPayload,
  exit: AgentExitEvidence
): boolean {
  const sender = event.agentPresence?.process
  if (sender) {
    return !exit.process || !isSameAgentProcess(sender, exit.process)
  }
  const agent = event.agentPresence?.agent ?? event.payload.agentType
  // A different known provider proves succession even without process identity.
  if (
    event.source !== undefined &&
    exit.agent &&
    agent &&
    agent !== 'unknown' &&
    agent !== exit.agent
  ) {
    return true
  }
  // An unidentified late Stop cannot prove a successor.
  return (
    opensNewTurn(event) ||
    (event.source !== undefined && isNewTurnEvent(event.source, event.hookEventName))
  )
}

/** Retire one key while preserving the exit under surviving aliases. */
export function releaseAgentExitKey(
  exits: Map<string, AgentExitEvidence>,
  paneKey: string
): boolean {
  const exit = exits.get(paneKey)
  exit?.paneKeys.delete(paneKey)
  return exits.delete(paneKey)
}

export function pruneAgentExits(
  exits: Map<string, AgentExitEvidence>,
  notBefore: number,
  isPaneRowRetained: (paneKey: string) => boolean
): void {
  for (const [key, exit] of exits) {
    // A retained resume row needs its exit to avoid appearing live.
    if (exit.at < notBefore && ![...exit.paneKeys].some(isPaneRowRetained)) {
      exits.delete(key)
    }
  }
}

export function serializeAgentExits(
  exits: ReadonlyMap<string, AgentExitEvidence>
): PersistedAgentExitEvidence[] {
  return [...new Set(exits.values())].map((exit) => ({
    at: exit.at,
    paneKeys: [...exit.paneKeys],
    ...(exit.agent ? { agent: exit.agent } : {}),
    ...(exit.process ? { process: exit.process } : {})
  }))
}

export function readPersistedAgentExits(
  value: unknown,
  notBefore: number
): PersistedAgentExitEvidence[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('at' in entry) || !('paneKeys' in entry)) {
      return []
    }
    const { at, paneKeys } = entry
    if (
      typeof at !== 'number' ||
      !Number.isFinite(at) ||
      at < notBefore ||
      !Array.isArray(paneKeys) ||
      paneKeys.length === 0 ||
      !paneKeys.every((key) => typeof key === 'string' && key.length > 0)
    ) {
      return []
    }
    const process = 'process' in entry ? readAgentProcessIdentity(entry.process) : undefined
    const agent = 'agent' in entry && typeof entry.agent === 'string' ? entry.agent : undefined
    return [
      {
        at,
        paneKeys: paneKeys.map(String),
        ...(agent ? { agent } : {}),
        ...(process ? { process } : {})
      }
    ]
  })
}
