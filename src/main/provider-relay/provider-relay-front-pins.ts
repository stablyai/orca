import { providerDiagnostic } from '../../shared/agent-session/failures/agent-session-failure'

/**
 * Chats whose launch handed its agent a daemon start's tool relay front: that start is the only one
 * the agent may run under, so it never holds an address another start's exit could free.
 */
const pins = new Map<string, string>()

/** Set (or, with null, clear) at each launch's tool resolution. */
export function pinProviderRelayFront(chatKey: string, daemonInstance: string | null): void {
  if (daemonInstance === null) {
    pins.delete(chatKey)
  } else {
    pins.set(chatKey, daemonInstance)
  }
}

/**
 * Taken once, by the launch's spawn, its process commit or its end, so no chat keeps one past its
 * launch; a reattach-only probe (which never spawns) only reads it.
 */
export function launchProviderRelayFrontPin(
  chatKey: string,
  only: 'spawn' | 'reattach' | undefined
): string | null {
  const pinned = pins.get(chatKey) ?? null
  if (only !== 'reattach') {
    pins.delete(chatKey)
  }
  return pinned
}

/** The launch is over (started or failed): its pin goes. */
export function takeProviderRelayFrontPin(chatKey: string): string | null {
  const pinned = pins.get(chatKey) ?? null
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
  pinned: string | null,
  daemonInstance: string | undefined,
  undo?: () => Promise<unknown>
): Promise<void> {
  if (pinned === null || daemonInstance === undefined || daemonInstance === pinned) {
    return
  }
  await undo?.().catch(() => {})
  throw new ProviderRelayFrontMovedError(chatKey)
}
