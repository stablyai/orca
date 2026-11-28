import { randomUUID } from 'node:crypto'
import {
  registerReattachableProviderRelayAgent,
  type KeptProviderRelay,
  type ProviderRelayWorkMarkers
} from '../../../provider-relay/app-provider-relays'
import type { ProviderRelayAckFloor } from '../../../provider-relay/relayed-provider-output'
import type { SharedProviderRelayAgent } from '../../../provider-relay/provider-relay-shared-agents'
import { CODEX_RELAY_WORK_MARKERS, type CodexAppServerRelayAs } from '../codex-app-server-relay'

/** Recorded with each shared server's relay; this build reattaches it and its chats' threads. */
export const CODEX_SHARED_RELAY_AGENT = 'codex-shared'

/** Whether a chat still has a part on a kept shared server attached here. */
let holds: SharedProviderRelayAgent['holds'] | null = null

export function onCodexSharedRelayChats(listener: { holds: NonNullable<typeof holds> }): void {
  holds = listener.holds
}

registerReattachableProviderRelayAgent(CODEX_SHARED_RELAY_AGENT, {
  provider: 'codex',
  shared: {
    // A chat that lets its part go leaves nothing here to release: Codex holds its threads.
    dropped: () => {},
    holds: (chatKey, relayId) => holds?.(chatKey, relayId) ?? true
  }
})

/** The relay's own key: the server's launch key, and a part unique to this server. */
export function codexSharedRelayChatKey(serverKey: string): string {
  return `codex-pool:${serverKey}:${randomUUID()}`
}

/** The parts of a shared server its relay's acks wait on. */
export type CodexSharedRelayAcks = {
  /** The first seq the server still needs kept; null keeps nothing (Codex has every chat's). */
  floor: () => number | null
  /** False holds the ack where it is (a hand-off reading what Codex reports open). */
  durable: (force: boolean) => Promise<boolean>
}

/** A shared server keeps no output for its chats: each rebuilds from Codex when it reopens. */
function sharedAckFloor(acks: CodexSharedRelayAcks): ProviderRelayAckFloor {
  return {
    observe: () => {},
    floor: (_through, released = 0) => {
      const floor = acks.floor()
      return floor !== null && floor > released ? floor : null
    }
  }
}

/** How a shared server rides the daemon: its own agent kind, idle markers and acks. */
export function codexSharedRelayAs(
  chatKey: string,
  acks: CodexSharedRelayAcks,
  attach?: KeptProviderRelay
): CodexAppServerRelayAs {
  const markers: ProviderRelayWorkMarkers = {
    ...CODEX_RELAY_WORK_MARKERS,
    agent: CODEX_SHARED_RELAY_AGENT,
    ackFloor: () => sharedAckFloor(acks)
  }
  return { chatKey, markers, durable: acks.durable, ...(attach ? { attach } : {}) }
}
