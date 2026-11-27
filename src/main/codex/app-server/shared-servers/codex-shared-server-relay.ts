import { randomUUID } from 'node:crypto'
import {
  registerReattachableProviderRelayAgent,
  type KeptProviderRelay,
  type ProviderRelayWorkMarkers
} from '../../../provider-relay/app-provider-relays'
import type { ProviderRelayAckFloor } from '../../../provider-relay/relayed-provider-output'
import { createCodexRelayAckFloor } from '../codex-relay-ack-floor'
import { CODEX_RELAY_WORK_MARKERS, type CodexAppServerRelayAs } from '../codex-app-server-relay'

/** Recorded with each shared server's relay; this build reattaches it and its chats' threads. */
export const CODEX_SHARED_RELAY_AGENT = 'codex-shared'

/** Who hears that a deleted chat no longer wants its part of a kept shared server. */
let chatDropped: ((chatKey: string, relay: KeptProviderRelay) => void) | null = null

export function onCodexSharedRelayChatDropped(listener: typeof chatDropped): void {
  chatDropped = listener
}

registerReattachableProviderRelayAgent(CODEX_SHARED_RELAY_AGENT, {
  provider: 'codex',
  shared: { dropped: (chatKey, relay) => chatDropped?.(chatKey, relay) }
})

/** The relay's own key: the server's launch key, and a part unique to this server. */
export function codexSharedRelayChatKey(serverKey: string): string {
  return `codex-pool:${serverKey}:${randomUUID()}`
}

/** The parts of a shared server its relay's acks wait on. */
export type CodexSharedRelayAcks = {
  /** The first seq any chat on it hasn't taken (queued, held for a claim, or unanswered). */
  floor: () => number | null
  /** Every chat on it has saved what it was handed. */
  durable: (force: boolean) => Promise<boolean>
  /** Given once a way to ask for an ack, for when the floor rises without a new line. */
  wake: (ack: () => void) => void
}

/** Codex's open-item floor, held lower still by what the server's chats haven't taken. */
function sharedAckFloor(acks: CodexSharedRelayAcks): ProviderRelayAckFloor {
  const items = createCodexRelayAckFloor()
  return {
    observe: items.observe,
    floor: (through, released = 0) => {
      const floors = [items.floor(through, released), acks.floor()]
      // A floor the daemon already let go of keeps nothing.
      const usable = floors.filter((seq): seq is number => seq !== null && seq > released)
      return usable.length > 0 ? Math.min(...usable) : null
    },
    wake: acks.wake
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
