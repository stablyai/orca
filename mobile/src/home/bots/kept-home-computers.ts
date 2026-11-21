// Each paired computer's one kept record for Home: its device copy read once, each live read folded in,
// and dropped whenever the computer's generation moves (unpaired, revoked, accepted again).
import {
  keepComputerBots,
  readKeptComputerBots,
  type KeptComputerBots
} from '../../bots/kept-computer-bots'
import {
  keptBotsGeneration,
  keptBotsRevoked,
  keptBotsUsable,
  subscribeKeptBotsFence
} from '../../bots/kept-server-bot-listings'
import type { HomeComputerBots } from './home-bots-query'
import { foldComputerRead } from './home-computer-record'

export type KeptHomeComputer = {
  generation: number
  /** Reading the device copy; read (or found missing), so reads fold in and are kept; or unreadable, so
   *  reads fold in for this launch but are never written over the copy still there (next launch reads it). */
  hydration: 'reading' | 'done' | 'unreadable'
  kept: KeptComputerBots | null
  /** The live read last folded in: folding it again with the same activity changes nothing. */
  folded: HomeComputerBots | null
}

let records: ReadonlyMap<string, KeptHomeComputer> = new Map()
const listeners = new Set<() => void>()

function publish(next: ReadonlyMap<string, KeptHomeComputer>): void {
  records = next
  listeners.forEach((listener) => listener())
}

export function subscribeKeptHomeComputers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function keptHomeComputers(): ReadonlyMap<string, KeptHomeComputer> {
  return records
}

// A record begun under an older generation goes, with everything it held; the next hydrate starts afresh.
subscribeKeptBotsFence(() => {
  const next = new Map(
    [...records].filter(([id, record]) => record.generation === keptBotsGeneration(id))
  )
  if (next.size !== records.size) {
    publish(next)
  }
})

/** Reads each computer's device copy once per generation; a revoked computer's is fenced, so it holds none. */
export function hydrateKeptHomeComputers(hostIds: readonly string[]): void {
  const unread = hostIds.filter((id) => !records.has(id))
  if (unread.length === 0) {
    return
  }
  const next = new Map(records)
  const reading = new Map<string, number>()
  for (const id of unread) {
    const generation = keptBotsGeneration(id)
    const revoked = keptBotsRevoked(id)
    next.set(id, { generation, hydration: revoked ? 'done' : 'reading', kept: null, folded: null })
    if (!revoked) {
      reading.set(id, generation)
    }
  }
  publish(next)
  if (reading.size === 0) {
    return
  }
  void readKeptComputerBots([...reading.keys()]).then((stored) => {
    const landed = new Map(records)
    for (const [id, generation] of reading) {
      const record = landed.get(id)
      if (record?.hydration === 'reading' && record.generation === generation) {
        const copy = stored[id]
        landed.set(
          id,
          copy === undefined
            ? { ...record, hydration: 'unreadable' }
            : { ...record, hydration: 'done', kept: copy }
        )
      }
    }
    publish(landed)
  })
}

function sameActivity(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** Folds a live read into its computer's record once the device copy is in, and keeps it on the device;
 *  with the copy unreadable, only for this launch, so a partial read never replaces it. */
export function foldKeptHomeComputer(
  hostId: string,
  read: HomeComputerBots,
  lastActivity: Readonly<Record<string, number>>
): void {
  const record = records.get(hostId)
  if (!record || record.hydration === 'reading' || !keptBotsUsable(hostId, record.generation)) {
    return
  }
  if (record.folded === read && sameActivity(record.kept?.lastActivity ?? {}, lastActivity)) {
    return
  }
  const folded = foldComputerRead(hostId, record.kept ?? undefined, read)
  const kept = { answers: folded.answers, groups: folded.groups, lastActivity }
  if (record.hydration === 'done') {
    keepComputerBots(hostId, kept)
  }
  publish(new Map(records).set(hostId, { ...record, kept, folded: read }))
}
