import type { ProviderRelayWorkMarkers } from '../../provider-relay/app-provider-relays'

/** A turn is work from its start notification to its completion; the daemon never idle-stops it. */
export const CODEX_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = {
  workStarts: ['turn/started'],
  workEnds: ['turn/completed']
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
