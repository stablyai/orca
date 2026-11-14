import { AsyncLocalStorage } from 'node:async_hooks'
import { Stats } from 'node:fs'
import { normalize } from 'node:path'

type Observation = {
  pending: Map<string, Promise<Stats>>
  facts: Map<string, Float64Array | { error: unknown }>
  closed: boolean
  wholeReads: Map<symbol, number>
  activity?: (allowanceMs: number) => void
}

const observations = new AsyncLocalStorage<Observation>()

/** One list pass owns its observations; interactive readers keep live filesystem semantics. */
export function withTranscriptFsObservation<T>(
  read: () => Promise<T>,
  activity?: (allowanceMs: number) => void
): Promise<T> {
  const scope: Observation = {
    pending: new Map(),
    facts: new Map(),
    closed: false,
    wholeReads: new Map(),
    activity
  }
  return observations.run(scope, read).finally(() => {
    scope.closed = true
    scope.pending.clear()
    scope.facts.clear()
    scope.wholeReads.clear()
  })
}

const STAT_FIELDS = [
  'dev',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'blksize',
  'ino',
  'size',
  'blocks',
  'atimeMs',
  'mtimeMs',
  'ctimeMs',
  'birthtimeMs'
] as const

export function observeTranscriptStat(path: string, read: () => Promise<Stats>): Promise<Stats> {
  const scope = observations.getStore()
  if (!scope || scope.closed) {
    return read()
  }
  const key = normalize(path)
  const fact = scope.facts.get(key)
  if (fact) {
    if (!(fact instanceof Float64Array)) {
      return Promise.reject(fact.error)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all Stats numeric fields are restored; type/date accessors are inherited from the native prototype.
    const stats = Object.create(Stats.prototype) as Stats
    STAT_FIELDS.forEach((field, index) => {
      stats[field] = fact[index]!
    })
    return Promise.resolve(stats)
  }
  const existing = scope.pending.get(key)
  if (existing) {
    return existing
  }
  const pending = read()
    .then(
      (stats) => {
        if (!scope.closed) {
          scope.facts.set(
            key,
            Float64Array.from(STAT_FIELDS, (field) => stats[field])
          )
        }
        return stats
      },
      (error: unknown) => {
        if (!scope.closed) {
          scope.facts.set(key, { error })
        }
        throw error
      }
    )
    .finally(() => scope.pending.delete(key))
  scope.pending.set(key, pending)
  return pending
}

/** Retention counters for the scan's operation-count contract. No filesystem work. */
export function transcriptObservationRetention(): {
  pending: number
  facts: number
  numericBytes: number
} {
  const scope = observations.getStore()
  let numericBytes = 0
  for (const fact of scope?.facts.values() ?? []) {
    if (fact instanceof Float64Array) {
      numericBytes += fact.byteLength
    }
  }
  return { pending: scope?.pending.size ?? 0, facts: scope?.facts.size ?? 0, numericBytes }
}

export function noteTranscriptFsActivity(): void {
  const scope = observations.getStore()
  if (!scope?.closed && scope?.activity) {
    let allowance = 0
    for (const value of scope.wholeReads.values()) {
      allowance = Math.max(allowance, value)
    }
    scope.activity(allowance)
  }
}

/** Whole-document readers have no chunk callbacks; budget their already observed byte length. */
export function beginTranscriptWholeRead(path: string): () => void {
  const scope = observations.getStore()
  if (!scope || scope.closed) {
    return () => undefined
  }
  const token = Symbol()
  scope.wholeReads.set(token, (observedSize(scope, path) / (1024 * 1024)) * 1000)
  noteTranscriptFsActivity()
  return () => {
    scope.wholeReads.delete(token)
    noteTranscriptFsActivity()
  }
}

function observedSize(scope: Observation, path: string): number {
  const fact = scope.facts.get(normalize(path))
  return fact instanceof Float64Array ? (fact[STAT_FIELDS.indexOf('size')] ?? 0) : 0
}
