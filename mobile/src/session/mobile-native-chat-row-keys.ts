import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  mobileNativeChatRunDescriptors,
  type MobileNativeChatRunPresentation
} from './mobile-native-chat-run-descriptors'
import {
  isSubagentGroupBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'

/** Where each drawn row sits on the page. A folded row's id is its first message's, so older
 *  messages joining a run would replace the row; its key stays while what it is made of draws. */
export type MobileNativeChatRowKeys = {
  /** The chat the keys belong to; nothing they held carries into another. */
  scope: string
  /** The source window's first message: it changes when a page, a cap trim or a replacement lands,
   *  even while every row keeps its key. */
  sourceHead: string | undefined
  keyOf: (message: NativeChatMessage) => string
  /** The key now drawing what a key of the last render drew; undefined once all of it left. */
  current: (key: string) => string | undefined
  /** The folded message a key's row is drawn for, which sets where the row sits: a roster keeps its
   *  key while the fold moves it to an older sibling's place. */
  placement: (key: string) => string
}

export type MobileNativeChatRowSources = { identity: string[]; content: string[] }
type Sources = MobileNativeChatRowSources

export type MobileNativeChatAssignedRows = {
  rows: readonly NativeChatMessage[]
  messages: readonly NativeChatMessage[]
  keyById: ReadonlyMap<string, string>
  /** Each row's sources, when that render worked them out. */
  sources?: readonly Sources[]
  prepareSources?: () => readonly Sources[]
}
type Assigned = MobileNativeChatAssignedRows

/** The fold keeps its sources' block objects, so a block names the message it came from. */
function blockOwners(messages: readonly NativeChatMessage[]): Map<NativeChatBlock, string> {
  const owners = new Map<NativeChatBlock, string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (!owners.has(block)) {
        owners.set(block, message.id)
      }
    }
  }
  return owners
}

/** What a row draws, by message and kind, and which of it makes the row what it is: a run is
 *  its assistant and its calls. Its results are content only, so a result left on a row of its
 *  own never takes the run's key. The fold makes a roster's group block; its group stands in. */
function sourcesOf(row: NativeChatMessage, owners: Map<NativeChatBlock, string>): Sources {
  const own = new Set<string>()
  const results = new Set<string>()
  for (const block of row.blocks) {
    const owner = owners.get(block)
    if (isSubagentGroupBlock(block)) {
      own.add(`subagent-group:${block.groupId}`)
    } else if (owner !== undefined && isToolResultBlock(block)) {
      results.add(`result:${owner}`)
    } else if (owner !== undefined) {
      own.add(`body:${owner}`)
    }
  }
  const content = [...own, ...results]
  const identity = own.size > 0 ? [...own] : results.size > 0 ? [...results] : [`body:${row.id}`]
  return { identity, content: content.length > 0 ? content : identity }
}

/** Physical rows and displayed runs attribute against the same raw snapshot, only when needed. */
export function prepareMobileNativeChatRowSources(messages: readonly NativeChatMessage[]) {
  let owners: Map<NativeChatBlock, string> | undefined
  const cache = new WeakMap<NativeChatMessage, Sources>()
  return (row: NativeChatMessage): Sources => {
    let sources = cache.get(row)
    if (!sources) {
      sources = sourcesOf(row, (owners ??= blockOwners(messages)))
      cache.set(row, sources)
    }
    return sources
  }
}

function sourcesByRow(
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  scopeOf?: (row: NativeChatMessage) => string | undefined
): Sources[] {
  const owners = blockOwners(messages)
  return rows.map((row) => {
    const sources = sourcesOf(row, owners)
    if (!scopeOf) {
      return sources
    }
    const scoped = (source: string) => `${source}\0${scopeOf(row) ?? ''}`
    return { identity: sources.identity.map(scoped), content: sources.content.map(scoped) }
  })
}

export function assignMobileNativeChatRowKeys(
  previous: Assigned | null,
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  fresh?: () => string,
  scopeOf?: (row: NativeChatMessage) => string | undefined,
  preparedSources?: () => readonly Sources[]
): Pick<Assigned, 'sources'> & {
  keyById: Map<string, string>
  moved: Map<string, string | undefined>
} {
  const keyById = new Map<string, string>()
  const taken = new Set<string>()
  const take = (row: NativeChatMessage, key: string): void => {
    keyById.set(row.id, key)
    taken.add(key)
  }
  const ids = new Set(rows.map((row) => row.id))
  let before: readonly Sources[] = []
  let now: readonly Sources[] | undefined
  const current = () => (now ??= preparedSources?.() ?? sourcesByRow(rows, messages, scopeOf))
  if (fresh) {
    current()
  }
  if (!fresh && previous?.rows.every((row) => ids.has(row.id))) {
    // Nothing left: every row keeps its key.
    for (const row of rows) {
      const key = previous.keyById.get(row.id)
      if (key !== undefined) {
        take(row, key)
      }
    }
  } else if (previous) {
    before =
      previous.sources ??
      previous.prepareSources?.() ??
      sourcesByRow(previous.rows, previous.messages)
    current()
    const was = new Map<string, number>()
    before.forEach(({ identity }, at) => identity.forEach((source) => was.set(source, at)))
    // A row continues the one row its identity came from, if that row's went nowhere else. Two
    // would be one key for two rows, so neither inherits rather than one being picked by position.
    const origins = current().map(
      ({ identity }) => new Set(identity.flatMap((s) => was.get(s) ?? []))
    )
    const heirs = new Map<number, number>()
    origins.forEach((from) => from.forEach((at) => heirs.set(at, (heirs.get(at) ?? 0) + 1)))
    origins.forEach((from, at) => {
      const [origin] = from
      const only = origin !== undefined && from.size === 1 && heirs.get(origin) === 1
      const key = only ? previous.keyById.get(previous.rows[origin]!.id) : undefined
      if (key !== undefined) {
        take(rows[at]!, key)
      }
    })
  }
  for (const row of rows.filter((unkeyed) => !keyById.has(unkeyed.id))) {
    let key = fresh?.() ?? row.id
    for (let n = 1; taken.has(key); n += 1) {
      key = `${row.id}~${n}`
    }
    take(row, key)
  }
  // A key no row kept names the first row that took in what it drew. Results left on rows of their
  // own when a run's last call went name none: the run ended, and its key goes with it.
  const drawnAt = new Map<string, number>()
  now?.forEach(({ identity, content }, at) => {
    if (!identity[0]!.startsWith('result:')) {
      content.forEach((s) => {
        if (!drawnAt.has(s)) {
          drawnAt.set(s, at)
        }
      })
    }
  })
  const moved = new Map<string, string | undefined>()
  before.forEach(({ content }, at) => {
    const key = previous?.keyById.get(previous.rows[at]!.id)
    if (key !== undefined && !taken.has(key)) {
      const holder = rows[Math.min(...content.map((s) => drawnAt.get(s) ?? Infinity))]
      moved.set(key, holder && keyById.get(holder.id))
    }
  })
  return { keyById, moved, ...(now ? { sources: now } : {}) }
}

/** Row keys for one shown chat, against the last committed render only, so what a key held dies
 *  with the rows that held it. */
export function useMobileNativeChatRowKeys(
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  scope: string,
  presentation?: MobileNativeChatRunPresentation
): MobileNativeChatRowKeys & {
  runOwners: ReadonlyMap<string, string>
  runPlacements: ReadonlyMap<string, string>
} {
  // Written at commit: a render React discards must not become the next one's last render.
  const committed = useRef<
    (Assigned & { scope: string; displayed: Assigned; serial: number }) | null
  >(null)
  const assigned = useMemo(() => {
    const previous = committed.current?.scope === scope ? committed.current : null
    const sourceOf = prepareMobileNativeChatRowSources(messages)
    const prepareSources = () => rows.map(sourceOf)
    const physical = assignMobileNativeChatRowKeys(
      previous,
      rows,
      messages,
      undefined,
      undefined,
      prepareSources
    )
    const runs = presentation ? mobileNativeChatRunDescriptors(presentation, sourceOf) : []
    const heads = runs.map((run) => run.row)
    let serial = previous?.serial ?? 0
    const displayed = {
      rows: heads,
      messages,
      ...assignMobileNativeChatRowKeys(
        previous?.displayed ?? null,
        heads,
        messages,
        () => `display-run:${serial++}`,
        undefined,
        () => runs.map((run) => run.sources)
      )
    }
    const runPlacements = new Map(Array.from(displayed.keyById, ([row, owner]) => [owner, row]))
    return { scope, rows, messages, prepareSources, ...physical, displayed, serial, runPlacements }
  }, [rows, messages, scope, presentation])
  useLayoutEffect(() => {
    committed.current = assigned
  }, [assigned])
  return useMemo(() => {
    let idByKey: Map<string, string> | undefined
    return {
      runOwners: assigned.displayed.keyById,
      runPlacements: assigned.runPlacements,
      scope: assigned.scope,
      sourceHead: assigned.messages[0]?.id,
      keyOf: (message: NativeChatMessage) => assigned.keyById.get(message.id) ?? message.id,
      current: (key: string) => (assigned.moved.has(key) ? assigned.moved.get(key) : key),
      placement: (key: string) =>
        (idByKey ??= new Map(Array.from(assigned.keyById, ([id, k]) => [k, id]))).get(key) ?? key
    }
  }, [assigned])
}
