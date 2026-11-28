import {
  KEY_SEPARATOR,
  providerRelayWorkKey,
  ProviderRelayWorkReader,
  type ProviderRelayWorkChange
} from '../../../daemon/provider-relay/provider-relay-work-markers'
import { CODEX_RELAY_WORK_MARKERS } from '../codex-app-server-relay'
import type { CodexSharedServerTurns } from './codex-shared-server-turns'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { SOFT_READ_TIMEOUT_MS } from '../../structured/threads/codex-kept-loaded-threads'
import { seedRunningCodexTurns } from './codex-shared-server-writer-stop'
import type { CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerLease } from './codex-shared-server-lease'

type OpenWork = Record<string, string[][]>

/** Past this many open tasks in a group the count is unknown, as the daemon's own is. */
const MAX_GROUP_TASKS = 1_024

/**
 * Every chat's open work on one relayed shared server, held chats' included, read from each
 * notification with Codex's work markers (starts and ends) as the daemon reads a detached relay's.
 * Seeded with what the daemon carried at the attach; handed to the daemon when the app lets the
 * server go. Indexed by each key's first part (its thread), so an end visits only that thread's
 * tasks, never every chat's.
 */
export class CodexSharedServerOpenWork {
  private readonly reader = new ProviderRelayWorkReader(CODEX_RELAY_WORK_MARKERS.markers)
  /** group → thread → open task keys. */
  private readonly groups = new Map<string, Map<string, Set<string>>>()
  private readonly sizes = new Map<string, number>()
  private overflowed = false

  /** The daemon's carried work at an attach, added to what notifications already showed. */
  seed(carried: OpenWork | undefined): void {
    for (const [group, keys] of Object.entries(carried ?? {})) {
      for (const parts of keys) {
        this.start(group, providerRelayWorkKey(parts))
      }
    }
  }

  /** Each notification the server read, as it parsed it: its line is never parsed again. */
  observe(method: string, params: unknown): void {
    for (const change of this.reader.readValue({ method, params })) {
      this.apply(change)
    }
  }

  /** The open set for a detach; null (unknown, never idle-stopped) while a turn start is unresolved:
   *  Codex may still run it. A turn a start's reply named, not yet seen starting, counts as open. */
  snapshot(turns: CodexSharedServerTurns): OpenWork | null {
    const { threads, startUnresolved } = turns.open
    if (startUnresolved || this.overflowed) {
      return null
    }
    const open: OpenWork = {}
    for (const [group, byThread] of this.groups) {
      open[group] = [...byThread.values()].flatMap((keys) =>
        [...keys].map((key) => key.split(KEY_SEPARATOR))
      )
    }
    const known = new Set((open.turn ?? []).map(([threadId]) => threadId))
    open.turn = [...(open.turn ?? []), ...threads.filter((id) => !known.has(id)).map((id) => [id])]
    return open
  }

  private apply(change: ProviderRelayWorkChange): void {
    if (change.effect === 'start') {
      this.start(change.group, change.key)
    } else if (change.effect === 'end') {
      this.end(change.group, change.key)
    } else {
      // A restated roster replaces the group.
      this.groups.delete(change.group)
      this.sizes.set(change.group, 0)
      change.keys.forEach((key) => this.start(change.group, key))
    }
  }

  private start(group: string, key: string): void {
    const byThread = this.groups.get(group) ?? new Map<string, Set<string>>()
    this.groups.set(group, byThread)
    const thread = key.split(KEY_SEPARATOR, 1)[0]!
    const keys = byThread.get(thread) ?? new Set<string>()
    byThread.set(thread, keys)
    if (!keys.has(key)) {
      keys.add(key)
      const size = (this.sizes.get(group) ?? 0) + 1
      this.sizes.set(group, size)
      this.overflowed ||= size > MAX_GROUP_TASKS
    }
  }

  /** Ends the task and every task under it (a closed thread ends its commands). */
  private end(group: string, key: string): void {
    const byThread = this.groups.get(group)
    const thread = key.split(KEY_SEPARATOR, 1)[0]!
    const keys = byThread?.get(thread)
    if (!byThread || !keys) {
      return
    }
    const under = key + KEY_SEPARATOR
    for (const open of keys) {
      if (open === key || open.startsWith(under)) {
        keys.delete(open)
        this.sizes.set(group, (this.sizes.get(group) ?? 1) - 1)
      }
    }
    if (keys.size === 0) {
      byThread.delete(thread)
    }
  }
}

/**
 * The open work to hand a server off with. A reattached server ran turns no notification here
 * named (started before this attach), so each thread its chats hold, open or not, is read first:
 * a hand-off never calls a running turn idle. Null (unknown) when one couldn't be ruled out.
 */
export async function codexSharedHandOffWork(
  server: {
    physicalConnection: CodexAppServerConnection | null
    recovery: CodexSharedServerRecovery
    leases: ReadonlySet<CodexSharedServerLease>
    turns: CodexSharedServerTurns
  },
  work: CodexSharedServerOpenWork,
  limited: (connection: CodexAppServerConnection) => Pick<CodexAppServerConnection, 'request'>
): Promise<OpenWork | null> {
  const connection = server.physicalConnection
  if (connection?.relay?.reattached) {
    const held = server.recovery.kept().groups.flatMap(({ threads }) => threads)
    const leased = [...server.leases].flatMap((lease) => [...lease.threads])
    const seeded = await seedRunningCodexTurns(
      limited(connection),
      [...leased, ...held.map(([threadId]) => threadId)],
      server.turns,
      SOFT_READ_TIMEOUT_MS
    ).catch(() => false)
    if (!seeded) {
      return null
    }
  }
  return work.snapshot(server.turns)
}
