import { providerDiagnostic } from '../../shared/agent-session/failures/agent-session-failure'
import type {
  ToolRelayFrontCaller,
  ToolRelayFrontGrant,
  ToolRelayFrontKept
} from '../daemon/protocol/daemon-tool-relay-front-protocol'

/**
 * A launch's daemon start, from its tool front, with what that start must hold for the agent's tools
 * (its grants and shared-tool caller), sent with its spawn.
 */
export type ProviderRelayFrontPin = { daemonInstance: string; kept: ToolRelayFrontKept }

type Pin = {
  daemonInstance: string
  grants: Map<string, ToolRelayFrontGrant>
  caller?: ToolRelayFrontCaller
}

/**
 * Chats whose launch handed its agent a daemon start's tool relay front: that start is the only one
 * the agent may run under, so it never holds an address another start's exit could free.
 */
const pins = new Map<string, Pin>()

function pinOn(chatKey: string, daemonInstance: string): Pin {
  const pinned = pins.get(chatKey)
  if (pinned?.daemonInstance === daemonInstance) {
    return pinned
  }
  const pin: Pin = { daemonInstance, grants: new Map() }
  pins.set(chatKey, pin)
  return pin
}

/** Set (or, with null, clear) at each launch's tool resolution; grants staged for it stay. */
export function pinProviderRelayFront(chatKey: string, daemonInstance: string | null): void {
  if (daemonInstance === null) {
    pins.delete(chatKey)
  } else {
    pinOn(chatKey, daemonInstance)
  }
}

/** A grant the launch's tools carry, for the daemon start whose front they were given. */
export function stageProviderRelayFrontGrant(
  chatKey: string,
  daemonInstance: string,
  grant: ToolRelayFrontGrant
): void {
  pinOn(chatKey, daemonInstance).grants.set(grant.owner, grant)
}

/** The launch's shared-tool caller; false when the launch has no front to keep it with. */
export function stageProviderRelayFrontCaller(
  chatKey: string,
  caller: ToolRelayFrontCaller
): boolean {
  const pin = pins.get(chatKey)
  if (!pin) {
    return false
  }
  pin.caller = caller
  return true
}

const asPin = (pin: Pin | undefined): ProviderRelayFrontPin | null =>
  pin
    ? {
        daemonInstance: pin.daemonInstance,
        kept: { grants: [...pin.grants.values()], ...(pin.caller ? { caller: pin.caller } : {}) }
      }
    : null

/**
 * Taken once, by the launch's spawn, its process commit or its end, so no chat keeps one past its
 * launch; a reattach-only probe (which never spawns) only reads it.
 */
export function launchProviderRelayFrontPin(
  chatKey: string,
  only: 'spawn' | 'reattach' | undefined
): ProviderRelayFrontPin | null {
  const pinned = asPin(pins.get(chatKey))
  if (only !== 'reattach') {
    pins.delete(chatKey)
  }
  return pinned
}

/** The launch is over (started or failed): its pin goes. */
export function takeProviderRelayFrontPin(chatKey: string): string | null {
  const pinned = pins.get(chatKey)?.daemonInstance ?? null
  pins.delete(chatKey)
  return pinned
}

const FRONT_MOVED_DETAIL =
  "Orca's background service restarted while this chat was starting, so nothing ran. Send again."

/** The daemon start changed between the launch's tools and its spawn; the next send starts afresh. */
export class ProviderRelayFrontMovedError extends Error {
  readonly providerDiagnostic = providerDiagnostic(FRONT_MOVED_DETAIL, 'person')

  constructor(readonly chatKey: string) {
    super('agent_tool_front_moved')
    this.name = 'ProviderRelayFrontMovedError'
  }
}

/**
 * Refuses a start on another daemon start than the chat's pinned front; `undo` first ends what that
 * start already spawned. Nothing is refused for an unpinned chat or a start that names none.
 */
export async function refuseMovedProviderRelayFront(
  chatKey: string,
  pinned: ProviderRelayFrontPin | null,
  daemonInstance: string | undefined,
  undo?: () => Promise<unknown>
): Promise<void> {
  if (
    pinned === null ||
    daemonInstance === undefined ||
    daemonInstance === pinned.daemonInstance
  ) {
    return
  }
  await undo?.().catch(() => {})
  throw new ProviderRelayFrontMovedError(chatKey)
}
