// The bots on this host's paired servers, as `bot list` and an `@` pick of one read them: each
// server's own roster, read from it, with the `--on` that reaches it.
import { z } from 'zod'
import type { BotRosterEntry, BotRosterServer } from '../../shared/bot-roster'
import { BotAgentReadSchema } from '../../shared/bot-types'

const ROSTER_READ_TIMEOUT_MS = 4_000

const PairedRosterEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agent: BotAgentReadSchema,
  paused: z.boolean(),
  specialty: z.string().nullable(),
  linked: z.array(z.string())
})

const PairedRoster = z.object({ bots: z.array(z.unknown()) })

export type PairedBotServers = {
  listOrchestrationWorkerServers(): Promise<readonly { environmentId: string; name: string }[]>
  callOrchestrationWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number
  ): Promise<unknown>
}

export type PairedBotRoster =
  | { environmentId: string; server: BotRosterServer; bots: BotRosterEntry[] }
  | { environmentId: string; server: BotRosterServer; unreachable: true }

/** Each paired server's bots, read in parallel; `only` limits the read to those server ids. A server
 *  that can't be read now says so in place of its bots. */
export async function readPairedBotRosters(
  runtime: PairedBotServers,
  only?: ReadonlySet<string>
): Promise<PairedBotRoster[]> {
  const servers = await runtime.listOrchestrationWorkerServers().catch(() => [])
  const read = servers.filter((server) => !only || only.has(server.environmentId))
  return await Promise.all(
    read.map(async ({ environmentId, name }): Promise<PairedBotRoster> => {
      const server = { name, on: serverSelector(servers, environmentId, name) }
      try {
        // Asked without allComputers, so the server lists only its own bots and asks no one else,
        // and without chats, which this list drops.
        const answer = PairedRoster.parse(
          await runtime.callOrchestrationWorkerServer(
            environmentId,
            'bots.roster',
            { withoutChats: true },
            ROSTER_READ_TIMEOUT_MS
          )
        )
        const bots = answer.bots.flatMap((value) => {
          const entry = PairedRosterEntry.safeParse(value)
          return entry.success ? [{ ...entry.data, server }] : []
        })
        return { environmentId, server, bots }
      } catch {
        return { environmentId, server, unreachable: true }
      }
    })
  )
}

/** A paired server's bots as last read; null before any read of it answered. */
export type KnownPairedBotRoster = {
  environmentId: string
  server: BotRosterServer
  bots: readonly BotRosterEntry[] | null
}

/** A paired server's roster as one read answered it, under its current name and `--on`. */
export type CachedPairedBotRoster = {
  environmentId: string
  server: BotRosterServer
  bots: readonly BotRosterEntry[]
}

export type PairedBotRosterCache = {
  /** The asked servers as last read, refreshing them in the background for the next ask. */
  read(servers: ReadonlySet<string>): Promise<KnownPairedBotRoster[]>
  /** Each server any read answered, without listing servers or touching the network. */
  lastRead(): readonly CachedPairedBotRoster[]
  /** Keeps what a read just answered, so the next ask needn't wait on it. `complete`: the read
   *  covered every paired server, so one it didn't list is no longer paired. */
  remember(rosters: readonly PairedBotRoster[], options?: { complete?: boolean }): void
}

/** The paired servers' bots without waiting on the network: what each was last read to hold, while
 *  a read in the background brings it up to date for the next ask. A server that can't be read keeps
 *  its last answer, under the name and `--on` it has now. */
export function pairedBotRosterCache(runtime: PairedBotServers): PairedBotRosterCache {
  const known = new Map<string, CachedPairedBotRoster>()
  const reading = new Set<string>()
  const remember: PairedBotRosterCache['remember'] = (rosters, options) => {
    // An empty list may be a failed server listing, so it keeps what is known.
    if (options?.complete && rosters.length > 0) {
      const listed = new Set(rosters.map((roster) => roster.environmentId))
      for (const id of known.keys()) {
        if (!listed.has(id)) {
          known.delete(id)
        }
      }
    }
    for (const roster of rosters) {
      const bots = 'bots' in roster ? roster.bots : known.get(roster.environmentId)?.bots
      if (bots) {
        known.set(roster.environmentId, {
          environmentId: roster.environmentId,
          server: roster.server,
          bots
        })
      }
    }
  }
  const refresh = (ids: readonly string[]): void => {
    const stale = ids.filter((id) => !reading.has(id))
    if (stale.length === 0) {
      return
    }
    stale.forEach((id) => reading.add(id))
    void readPairedBotRosters(runtime, new Set(stale))
      .then((rosters) => remember(rosters))
      .catch(() => {})
      .finally(() => stale.forEach((id) => reading.delete(id)))
  }
  return {
    read: async (servers) => {
      const all = await runtime.listOrchestrationWorkerServers().catch(() => [])
      const asked = all.filter((server) => servers.has(server.environmentId))
      refresh(asked.map((server) => server.environmentId))
      return asked.map(({ environmentId, name }) => ({
        environmentId,
        server: { name, on: serverSelector(all, environmentId, name) },
        bots: known.get(environmentId)?.bots ?? null
      }))
    },
    lastRead: () => [...known.values()],
    remember
  }
}

/** This host's roster, then each paired server's bots, and the servers that couldn't be read. */
export function withPairedBotRosters(
  own: BotRosterEntry[],
  servers: readonly PairedBotRoster[]
): { bots: BotRosterEntry[]; unreachable: { name: string }[] } {
  return {
    bots: [...own, ...servers.flatMap((server) => ('bots' in server ? server.bots : []))],
    unreachable: servers.flatMap((server) =>
      'unreachable' in server ? [{ name: server.server.name }] : []
    )
  }
}

// A name reads better than an id, but only one no other paired server shares, and one a command and
// its code span can hold as typed.
function serverSelector(
  servers: readonly { environmentId: string; name: string }[],
  environmentId: string,
  name: string
): string {
  const shared = servers.some(
    (other) => other.environmentId !== environmentId && other.name === name
  )
  return shared || !/^[^`'\\\p{Cc}\p{Zl}\p{Zp}]+$/u.test(name) || name.trim() !== name
    ? environmentId
    : name
}
