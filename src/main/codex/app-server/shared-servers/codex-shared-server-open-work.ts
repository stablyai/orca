import {
  ProviderRelayOpenWork,
  ProviderRelayWorkReader
} from '../../../daemon/provider-relay/provider-relay-work-markers'
import { CODEX_RELAY_WORK_MARKERS } from '../codex-app-server-relay'
import type { CodexSharedServerTurns } from './codex-shared-server-turns'

type OpenWork = Record<string, string[][]>

/**
 * Every chat's open work on one relayed shared server, held chats' included, read from each
 * notification with Codex's work markers (starts and ends) as the daemon reads a detached relay's. Seeded with
 * what the daemon carried at the attach; handed to the daemon when the app lets the server go.
 */
export class CodexSharedServerOpenWork {
  private readonly reader = new ProviderRelayWorkReader(CODEX_RELAY_WORK_MARKERS.markers)
  private work = new ProviderRelayOpenWork({})

  /** The daemon's carried work at an attach, added to what lines already showed. */
  seed(carried: OpenWork | undefined): void {
    if (carried) {
      this.work = new ProviderRelayOpenWork(merge(this.work.keys(), carried))
    }
  }

  /** Each notification the server read, as it parsed it: its line is never parsed again. */
  observe(method: string, params: unknown): void {
    for (const change of this.reader.readValue({ method, params })) {
      this.work.apply(change)
    }
  }

  /** The open set for a detach; null (unknown, never idle-stopped) while a turn start is unresolved:
   *  Codex may still run it. A turn a start's reply named, not yet seen starting, counts as open. */
  snapshot(turns: CodexSharedServerTurns): OpenWork | null {
    const { threads, startUnresolved } = turns.open
    if (startUnresolved || this.work.unaccounted) {
      return null
    }
    return merge(this.work.keys(), { turn: threads.map((threadId) => [threadId]) })
  }
}

function merge(into: OpenWork, more: OpenWork): OpenWork {
  const merged: OpenWork = { ...into }
  for (const [group, keys] of Object.entries(more)) {
    const seen = new Set((merged[group] ?? []).map((key) => JSON.stringify(key)))
    merged[group] = [
      ...(merged[group] ?? []),
      ...keys.filter((key) => !seen.has(JSON.stringify(key)))
    ]
  }
  return merged
}
