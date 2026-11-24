// Each server's last bot listing, kept in the paired host's device store so a server that is down after a
// phone restart still lists its bots, dimmed; and the writer and fences Home's kept computers share
// (kept-computer-bots.ts). Written only when a record changed, a burst at a time.
import * as z from 'zod'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { normalizeBotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { WorkspaceLineage, WorktreeLineage } from '../../../src/shared/worktree/lineage-types'
import { keptServerBotStore as deviceStore } from './kept-server-bot-store'
import { phoneBotSchema } from './host-bots-operations'
import type { ListedHostBots } from './host-bot-listing'

export const KEEP_SERVER_BOTS_AFTER_MS = 2_000

const KEY_PREFIX = 'bots.serverListing.v1|'

const someObject = (value: unknown): boolean => typeof value === 'object' && value !== null

// Pictures stay out: they are large, and a dimmed row shows the bot's face without them.
const keptListingSchema = z.object({
  kind: z.literal('listed'),
  hostId: z.custom<ExecutionHostId>((value) => typeof value === 'string'),
  hostLabel: z.string(),
  installationId: z.string().optional(),
  bots: z.array(phoneBotSchema),
  hideBotCreated: z.boolean(),
  view: z.unknown().transform(normalizeBotSidebarView),
  workspaceLineage: z.record(z.string(), z.custom<WorkspaceLineage>(someObject)),
  worktreeLineage: z.record(z.string(), z.custom<WorktreeLineage>(someObject)),
  // Listings saved before worker availability was explicit had a successful lineage read.
  workerStatus: z.enum(['available', 'unavailable']).catch('available'),
  createRefusal: z.enum(['bots-off', 'update', 'update-desktop']).optional(),
  groups: z.array(z.custom<BotGroup>(someObject)).optional()
})

function storeKey(hostId: ExecutionHostId): string {
  return `${KEY_PREFIX}${hostId}`
}

function serialize(listing: ListedHostBots): string {
  // Unseen counts move with every bot turn and a dimmed row shows none, so they never count as a change.
  const { offline: _offline, unseen: _unseen, ...kept } = listing
  return JSON.stringify(kept)
}

// What each server's stored record holds, so an unchanged listing is never written again.
export const stored = new Map<string, string | null>()
const pending = new Map<string, string | null>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function keptSlot(pairedHostId: string, key: string): string {
  return `${pairedHostId}\n${key}`
}
const slot = keptSlot

// Each paired host's generation: unpairing it moves on, so a read or write begun before is dropped.
const generations = new Map<string, number>()
// Paired hosts that definitely revoked this phone: their kept bots go until it is accepted again.
const revokedHosts = new Set<string>()
const fenceListeners = new Set<() => void>()
let fenceVersion = 0

export function keptBotsGeneration(pairedHostId: string): number {
  return generations.get(pairedHostId) ?? 0
}

/** Whether the paired host definitely revoked this phone: its device copy is fenced until accepted again. */
export function keptBotsRevoked(pairedHostId: string): boolean {
  return revokedHosts.has(pairedHostId)
}

/** Whether this world may still use a paired host's kept bots begun at `generation`. */
export function keptBotsUsable(pairedHostId: string, generation: number): boolean {
  return !revokedHosts.has(pairedHostId) && keptBotsGeneration(pairedHostId) === generation
}

/** Changes when a paired host's kept bots are forgotten or revoked, for screens holding copies. */
export function subscribeKeptBotsFence(listener: () => void): () => void {
  fenceListeners.add(listener)
  return () => fenceListeners.delete(listener)
}

export function keptBotsFenceVersion(): number {
  return fenceVersion
}

function dropHost(pairedHostId: string): void {
  const prefix = `${pairedHostId}\n`
  for (const key of [...stored.keys(), ...pending.keys(), ...timers.keys()]) {
    if (key.startsWith(prefix)) {
      clearTimeout(timers.get(key))
      timers.delete(key)
      pending.delete(key)
      stored.delete(key)
    }
  }
  fenceVersion += 1
  fenceListeners.forEach((listener) => listener())
}

/** A definite revocation (K6) drops what this world keeps of the host's bots; the device store fences
 *  its own copy. Accepted again, the host is read off the device and kept afresh. */
export function setKeptBotsRevoked(pairedHostId: string, revoked: boolean): void {
  if (revoked === revokedHosts.has(pairedHostId)) {
    return
  }
  // Either way a new generation: nothing held or begun on the other side of the change is used again.
  generations.set(pairedHostId, keptBotsGeneration(pairedHostId) + 1)
  if (revoked) {
    revokedHosts.add(pairedHostId)
  } else {
    revokedHosts.delete(pairedHostId)
  }
  dropHost(pairedHostId)
}

/** Unpairing forgets the host's kept bots in this world, and drops reads and writes still out. */
export function forgetKeptBots(pairedHostId: string): void {
  generations.set(pairedHostId, keptBotsGeneration(pairedHostId) + 1)
  revokedHosts.delete(pairedHostId)
  dropHost(pairedHostId)
}

/** The servers' kept listings on this paired host; none when the store can't be read. */
export async function readKeptServerBotListings(
  pairedHostId: string,
  hostIds: readonly ExecutionHostId[]
): Promise<ListedHostBots[]> {
  const generation = keptBotsGeneration(pairedHostId)
  const store = hostIds.length === 0 ? null : await deviceStore().catch(() => null)
  if (!store) {
    return []
  }
  const read = await store.read(pairedHostId, 'cache', hostIds.map(storeKey)).catch(() => null)
  if (read?.status !== 'ok' || !keptBotsUsable(pairedHostId, generation)) {
    return []
  }
  return read.values.flatMap((raw, index) => {
    const hostId = hostIds[index]
    if (!stored.has(slot(pairedHostId, storeKey(hostId)))) {
      stored.set(slot(pairedHostId, storeKey(hostId)), raw)
    }
    if (raw === null) {
      return []
    }
    try {
      const parsed = keptListingSchema.safeParse(JSON.parse(raw))
      return parsed.success && parsed.data.hostId === hostId ? [parsed.data] : []
    } catch {
      return []
    }
  })
}

/** Keeps the server's newest listing, or forgets it (null) once the server is unpaired; written after the burst settles. */
export function keepServerBotListing(
  pairedHostId: string,
  hostId: ExecutionHostId,
  listing: ListedHostBots | null
): void {
  keepRecord(pairedHostId, storeKey(hostId), listing ? serialize(listing) : null)
}

/** Keeps one record in the paired host's device store after the burst settles; unchanged ones aren't written. */
export function keepRecord(pairedHostId: string, key: string, value: string | null): void {
  const at = slot(pairedHostId, key)
  const generation = keptBotsGeneration(pairedHostId)
  pending.set(at, value)
  clearTimeout(timers.get(at))
  timers.set(
    at,
    setTimeout(() => {
      timers.delete(at)
      if (!pending.has(at)) {
        return
      }
      const next = pending.get(at) ?? null
      pending.delete(at)
      if (stored.get(at) === next || !keptBotsUsable(pairedHostId, generation)) {
        return
      }
      stored.set(at, next)
      void deviceStore()
        .then((store) =>
          !store
            ? { written: true }
            : // Unpaired or revoked while the store opened: the write would outlive the wipe.
              keptBotsUsable(pairedHostId, generation)
              ? store.write(pairedHostId, 'cache', [{ key, value: next }])
              : { written: false }
        )
        .then((result) => {
          if (!result.written && stored.get(at) === next) {
            stored.delete(at)
          }
        })
        .catch(() => stored.delete(at))
    }, KEEP_SERVER_BOTS_AFTER_MS)
  )
}
