// A paired computer's answers as Home draws them: each computer's latest good answer, fresh or kept.
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import type { BotGroup } from '../../../../src/shared/bots/bot-group'
import type { KeptComputerAnswer, KeptComputerBots } from '../../bots/kept-computer-bots'
import { hostBotsKey } from '../../bots/host-bots-read'
import type { HomeComputerBots } from './home-bots-query'

/** How Home holds a computer's answer: read on this connection, kept while it may answer again, or
 *  kept while it (or the route to it) is down. */
export type HomeComputerMode = 'live' | 'pending' | 'offline'

export type HomeComputerEntry = KeptComputerAnswer & { mode: HomeComputerMode }

const succeeded = (entry: Pick<KeptComputerAnswer, 'answer'>): boolean =>
  entry.answer.kind === 'bots' || entry.answer.kind === 'no-capability'

/** Folds a fresh read into the kept record, computer by computer: a good answer replaces its computer's,
 *  a failed one leaves the last good one standing, and only a good relay inventory drops a server it no
 *  longer lists. Rooms whose read failed stay as they were. */
export function foldComputerRead(
  pairedHostId: string,
  kept: KeptComputerBots | undefined,
  read: HomeComputerBots
): { answers: KeptComputerAnswer[]; entries: HomeComputerEntry[]; groups: readonly BotGroup[] } {
  const inventoryKey = hostBotsKey(pairedHostId, 'relay-inventory')
  const inventoryFailed = read.answers.some((entry) => entry.key === inventoryKey)
  const keptByKey = new Map((kept?.answers ?? []).map((entry) => [entry.key, entry]))
  const answers: KeptComputerAnswer[] = []
  const entries: HomeComputerEntry[] = []
  const seen = new Set<string>()
  for (const entry of read.answers) {
    if (entry.key === inventoryKey) {
      continue
    }
    seen.add(entry.key)
    const last = keptByKey.get(entry.key)
    if (succeeded(entry)) {
      const fresh = { ...entry, readAt: read.readAt }
      answers.push(fresh)
      entries.push({ ...fresh, mode: 'live' })
    } else if (last) {
      answers.push(last)
      entries.push({ ...last, mode: entry.answer.kind === 'unreachable' ? 'offline' : 'pending' })
    } else {
      // Nothing to keep: the entry still says this computer can't be reached or read.
      entries.push({ ...entry, readAt: read.readAt, mode: 'live' })
    }
  }
  if (inventoryFailed) {
    for (const last of kept?.answers ?? []) {
      if (!seen.has(last.key) && last.executionHost !== LOCAL_EXECUTION_HOST_ID) {
        answers.push(last)
        entries.push({ ...last, mode: 'pending' })
      }
    }
  }
  return { answers, entries, groups: read.groups ?? kept?.groups ?? [] }
}

/** A computer with no fresh read: its kept answers, as they were or dimmed. */
export function keptComputerEntries(
  kept: KeptComputerBots,
  mode: Exclude<HomeComputerMode, 'live'>
): HomeComputerEntry[] {
  return kept.answers.map((entry) => ({ ...entry, mode }))
}

const MODE_RANK: Record<HomeComputerMode, number> = { live: 2, pending: 1, offline: 0 }

/** One route per server install, among routes already eligible: a good answer over a failed one, then a
 *  live one over a kept one, a direct pairing over a relay, one that passes New bot on (a relay only while
 *  its paired computer is live and takes one, as Runs on accepts), and the newest read. */
export function bestHomeRoutes(entries: readonly HomeComputerEntry[]): HomeComputerEntry[] {
  const relaysCreate = new Set(
    entries.flatMap((entry) =>
      entry.key === hostBotsKey(entry.pairedHostId) &&
      entry.mode === 'live' &&
      entry.answer.kind === 'bots' &&
      entry.answer.takesCreate
        ? [entry.pairedHostId]
        : []
    )
  )
  const creates = (entry: HomeComputerEntry): number =>
    entry.answer.kind === 'bots' &&
    entry.answer.takesCreate &&
    (entry.executionHost === LOCAL_EXECUTION_HOST_ID || relaysCreate.has(entry.pairedHostId))
      ? 1
      : 0
  const better = (a: HomeComputerEntry, b: HomeComputerEntry): boolean => {
    const order = [
      Number(succeeded(a)) - Number(succeeded(b)),
      MODE_RANK[a.mode] - MODE_RANK[b.mode],
      Number(a.executionHost === LOCAL_EXECUTION_HOST_ID) -
        Number(b.executionHost === LOCAL_EXECUTION_HOST_ID),
      creates(a) - creates(b),
      a.readAt - b.readAt
    ]
    return (order.find((step) => step !== 0) ?? 0) > 0
  }
  const chosen = new Map<string, HomeComputerEntry>()
  for (const entry of entries) {
    const id = entry.installationId
    const current = id ? chosen.get(id) : undefined
    if (id && (!current || better(entry, current))) {
      chosen.set(id, entry)
    }
  }
  return entries.filter(
    (entry) => !entry.installationId || chosen.get(entry.installationId) === entry
  )
}
